"""Harbor agent adapter for DeepSeek Harness (DSH) + the graph plugin.

Usage (from the repo root, after building the plugin tarball):

  PYTHONPATH="$PWD/bench/official/terminal-bench" \
  DSH_PLUGIN_TARBALL="$PWD/dist/dsh-graph-loop-0.1.2.tgz" \
  harbor run -d terminal-bench/terminal-bench@latest \
    --agent dsh_agent:DshAgent \
    --model deepseek/deepseek-flash \
    --ae DEEPSEEK_API_KEY=... \
    --env docker -i terminal-bench/html-js-filter -l 1

The agent installs Node + the DSH CLI inside the task container, installs the
packed graph plugin into a throwaway profile, and runs one non-interactive DSH
turn in /app. No DSH source changes are needed.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


NODE_VERSION = "24.9.0"
DSH_VERSION = "0.2.2-rc.1"
NODE_BASE = f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux"
PROFILE = "tb"
PATCH = "/tmp/dsh-tool-policy.patch.yml"
PLUGIN_TARBALL = "/tmp/dsh-graph-loop.tgz"


class DshAgent(BaseAgent):
    """Run one DSH graph-plugin turn inside the Terminal-Bench task container."""

    capabilities = AgentCapabilities(windows=False)
    DEFAULT_SETUP_TIMEOUT_SEC = 1800.0

    @staticmethod
    @override
    def name() -> str:
        return "dsh"

    @override
    def version(self) -> str:
        return "0.1.0"

    def __init__(self, logs_dir: Path, **kwargs):
        super().__init__(logs_dir=logs_dir, **kwargs)
        tarball = os.environ.get("DSH_PLUGIN_TARBALL")
        if not tarball:
            raise RuntimeError("DSH_PLUGIN_TARBALL must point at the packed dsh-graph-loop tarball")
        self.plugin_tarball = Path(tarball).resolve()
        if not self.plugin_tarball.is_file():
            raise RuntimeError(f"DSH_PLUGIN_TARBALL does not exist: {self.plugin_tarball}")
        self.agent_timeout_sec = float(os.environ.get("DSH_AGENT_TIMEOUT_SEC", "1800"))
        self.stock = os.environ.get("DSH_STOCK") == "1"

    async def _exec(self, environment: BaseEnvironment, command: str, *, timeout: int = 1800, env: dict[str, str] | None = None):
        result = await environment.exec(command=command, timeout_sec=timeout, env=env or {})
        if result.return_code != 0:
            raise RuntimeError(
                f"DSH adapter command failed ({result.return_code}): {command}\n"
                f"stdout:\n{(result.stdout or '')[-4000:]}\nstderr:\n{(result.stderr or '')[-4000:]}"
            )
        return result

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        await self._exec(
            environment,
            "set -e\n"
            "if ! command -v node >/dev/null 2>&1; then\n"
            "  ARCH=$(uname -m)\n"
            "  case \"$ARCH\" in x86_64) NODE_ARCH=x64 ;; aarch64|arm64) NODE_ARCH=arm64 ;; *) echo \"unsupported arch $ARCH\"; exit 1 ;; esac\n"
            f"  URL={NODE_BASE}-$NODE_ARCH.tar.gz\n"
            "  if command -v curl >/dev/null 2>&1; then curl -fsSL \"$URL\" -o /tmp/node.tar.gz\n"
            "  elif command -v wget >/dev/null 2>&1; then wget -q \"$URL\" -O /tmp/node.tar.gz\n"
            "  elif command -v python3 >/dev/null 2>&1; then python3 -c \"import sys,urllib.request; urllib.request.urlretrieve(sys.argv[1], '/tmp/node.tar.gz')\" \"$URL\"\n"
            "  else echo 'need curl, wget or python3 to install Node'; exit 1; fi\n"
            "  tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1\n"
            "fi\n"
            "node --version\n"
            "npm --version\n",
            timeout=1800,
        )
        await self._exec(
            environment,
            "npm config set fetch-retries 5\n"
            "npm config set fetch-timeout 600000\n"
            f"npm install -g @deepseek-ai/dsh@{DSH_VERSION} pnpm@11.28.5 >/tmp/dsh-install.log 2>&1 || "
            "{ tail -100 /tmp/dsh-install.log; exit 1; }\n"
            "dsh --version\n"
            "pnpm --version\n",
            timeout=1800,
        )
        await self._exec(
            environment,
            f"dsh --profile {PROFILE} --from-default-profile headless --dump-config >/dev/null\n",
            timeout=1800,
        )
        if self.stock:
            self.logger.info("DSH_STOCK=1: running the stock headless loop (control arm)")
            return
        await environment.upload_file(str(self.plugin_tarball), PLUGIN_TARBALL)
        await self._exec(
            environment,
            "set -e\n"
            f"dsh plugin --profile {PROFILE} add {PLUGIN_TARBALL} >/tmp/dsh-plugin.log 2>&1 || "
            "{ tail -100 /tmp/dsh-plugin.log; exit 1; }\n"
            f"printf '%s\\n' '- id: graph-loop' '  config:' '    toolPolicy: preset' > {PATCH}\n"
            f"dsh --profile {PROFILE} --patch {PATCH} --dump-config >/tmp/dsh-dump.yml\n"
            "grep -q 'id: graph-loop' /tmp/dsh-dump.yml\n"
            "grep -q 'toolPolicy: preset' /tmp/dsh-dump.yml\n",
            timeout=1800,
        )

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = dict(self.extra_env)
        # DSH's headless profile reads DEEPSEEK_API_KEY from the environment.
        patch = "" if self.stock else f" --patch {PATCH}"
        command = (
            "set -e\n"
            "cd /app 2>/dev/null || cd /\n"
            f"dsh --profile {PROFILE}{patch} {shlex.quote(instruction)}\n"
        )
        result = await self._exec(environment, command, timeout=int(self.agent_timeout_sec), env=env)
        try:
            await environment.download_dir("/root/.dsh/sessions", str(self.logs_dir / "dsh-sessions"))
        except Exception as exc:  # session logs are optional for the benchmark score
            self.logger.warning(f"could not download DSH sessions: {exc}")
        (self.logs_dir / "dsh-stdout.log").write_text(result.stdout or "")
        (self.logs_dir / "dsh-stderr.log").write_text(result.stderr or "")
        context.metadata = {"agent": "dsh", "plugin": "dsh-graph-loop" if not self.stock else "stock", "tool_policy": "preset"}
