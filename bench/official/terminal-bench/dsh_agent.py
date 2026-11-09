"""Harbor agent adapter for DeepSeek Harness (DSH) + the graph plugin.

Usage (from the repo root, after building the plugin tarball):

  source bench/official/terminal-bench/network.sh   # mirrors + proxy contract
  PYTHONPATH="$PWD/bench/official/terminal-bench" \
  DSH_PLUGIN_TARBALL="$PWD/dist/dsh-graph-loop-bench.tgz" \
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
import re
import shlex
from pathlib import Path
from typing import override

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


NODE_VERSION = "24.9.0"
# DSH version installed in the task container. This is the tested version; it is
# pinned exactly because npm prerelease ranges do not order across patch levels
# (^0.2.1-rc.3 does not admit 0.2.2-rc.1).
DSH_VERSION = "0.2.2-rc.1"


def _env_names(contract: str, default: str) -> tuple[str, ...]:
    """Variable-name contract published by network.sh, with a conservative fallback."""
    return tuple((os.environ.get(contract) or default).split())


# Package-index values are resolved by network.sh (the single source of truth) and
# forwarded into the task container as-is; this adapter owns no mirror URLs. A
# direct Harbor invocation without network.sh forwards whatever the operator set.
MIRROR_ENV: dict[str, str] = {
    key: os.environ[key]
    for key in _env_names(
        "DSH_CONTAINER_MIRROR_VARS",
        "PIP_INDEX_URL PIP_TRUSTED_HOST UV_DEFAULT_INDEX "
        "NPM_CONFIG_REGISTRY npm_config_registry",
    )
    if os.environ.get(key)
}

# network.sh contract: DSH_NODE_MIRROR is a base URL without a version. Appending the
# version here keeps the shell and Python sides from disagreeing about its shape.
NODE_MIRROR = (os.environ.get("DSH_NODE_MIRROR") or "").rstrip("/")
NODE_BASE = (
    f"{NODE_MIRROR}/v{NODE_VERSION}/node-v{NODE_VERSION}-linux"
    if NODE_MIRROR
    else f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux"
)
PROFILE = "tb"
PATCH = "/tmp/dsh-tool-policy.patch.yml"
PLUGIN_TARBALL = "/tmp/dsh-graph-loop.tgz"
# The graph loop's designed terminal when recovery/replan is exhausted. It exits 1, so
# the aggregate needs an explicit marker to tell it apart from infrastructure failures
# (docs/EVALUATION.md "Trial validity" rule 2); the loop writes
# `dsh: GRAPH_FAILED: graph run ended ...`. Anchor to that line so model prose that
# happens to mention GRAPH_FAILED cannot turn a transport crash into a valid trial.
GRAPH_FAILED_RE = re.compile(r"(?m)^dsh: GRAPH_FAILED:")

# Host proxy configuration is required inside the task container: Docker does
# not inherit the host environment, and the benchmark container needs npm plus
# the model API. The names are the network.sh contract; the values come from the
# harness process environment.
PROXY_ENV = {
    key: os.environ[key]
    for key in _env_names("DSH_PROXY_VARS", "HTTP_PROXY HTTPS_PROXY NO_PROXY NODE_USE_ENV_PROXY")
    if os.environ.get(key)
}


class DshAgent(BaseAgent):
    """Run one DSH graph-plugin turn inside the Terminal-Bench task container."""

    # Harbor refuses to run a task with MCP servers unless the agent declares
    # support. DSH has no SSE MCP client, so the servers are exposed to the
    # prompt rather than registered as native tools; this keeps the task a
    # scored trial instead of an infrastructure error. Report it as a known DSH
    # limitation, not as harness breakage.
    capabilities = AgentCapabilities(windows=False, mcp_servers=True)
    DEFAULT_SETUP_TIMEOUT_SEC = 1800.0
    # Fallback for direct Harbor invocations. run-subset.sh always exports the
    # task's [agent].timeout_sec (or DSH_AGENT_TIMEOUT_CAP), which overrides this.
    DEFAULT_AGENT_TIMEOUT_SEC = 900.0

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
        self.agent_timeout_sec = float(
            os.environ.get("DSH_AGENT_TIMEOUT_SEC", str(self.DEFAULT_AGENT_TIMEOUT_SEC))
        )
        self.stock = os.environ.get("DSH_STOCK") == "1"

    async def _exec(self, environment: BaseEnvironment, command: str, *, timeout: int = 1800, env: dict[str, str] | None = None):
        result = await environment.exec(command=command, timeout_sec=timeout, env={**PROXY_ENV, **MIRROR_ENV, **(env or {})})
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
            "if ! command -v dsh >/dev/null 2>&1; then\n"
            "  npm config set fetch-retries 5\n"
            "  npm config set fetch-timeout 600000\n"
            f"  npm install -g @deepseek-ai/dsh@{DSH_VERSION} pnpm@11.28.5 >/tmp/dsh-install.log 2>&1 || "
            "{ tail -100 /tmp/dsh-install.log; exit 1; }\n"
            "fi\n"
            "dsh --version\n"
            "pnpm --version\n",
            timeout=1800,
        )
        await self._exec(
            environment,
            f"rm -rf /root/.dsh\ndsh --profile {PROFILE} --from-default-profile headless --dump-config >/dev/null\n",
            timeout=1800,
        )
        # Both arms share the same instrument policy. The sandbox is the
        # container itself (disposable Terminal-Bench env), so danger-full-access
        # is the container-scoped equivalent of "the workspace is writable";
        # workspace-write rooted at /app caps tasks that must write /workspace,
        # /results or installed site-packages. Retries absorb TRANSPORT noise.
        patch_lines = [
            '- id: sandbox-policy', '  config:', '    mode: danger-full-access',
            '- id: llm-deepseek', '  config:', '    retryPolicy:',
            '      mode: normal', '      maxRetries: 3',
        ]
        if not self.stock:
            patch_lines += [
                '- id: graph-loop', '  config:',
                '    toolPolicy: preset', '    benchGuards: true',
            ]
        patch_text = '\n'.join(patch_lines)
        if not self.stock:
            await environment.upload_file(str(self.plugin_tarball), PLUGIN_TARBALL)
        await self._exec(
            environment,
            "set -e\n"
            + ("" if self.stock else
               "dsh plugin --profile {0} add {1} >/tmp/dsh-plugin.log 2>&1 || "
               "{{ tail -100 /tmp/dsh-plugin.log; exit 1; }}\n".format(PROFILE, PLUGIN_TARBALL))
            + f"cat > {PATCH} <<'DSH_PATCH'\n{patch_text}\nDSH_PATCH\n"
            + f"dsh --profile {PROFILE} --patch {PATCH} --dump-config >/tmp/dsh-dump.yml\n"
            + ("grep -q 'id: graph-loop' /tmp/dsh-dump.yml\n"
               "grep -q 'toolPolicy: preset' /tmp/dsh-dump.yml\n" if not self.stock else
               "grep -q 'sandbox-policy' /tmp/dsh-dump.yml\n"
               "grep -q 'danger-full-access' /tmp/dsh-dump.yml\n")
            + "grep -q 'maxRetries: 3' /tmp/dsh-dump.yml\n",
            timeout=1800,
        )
        if self.stock:
            self.logger.info("DSH_STOCK=1: running the stock headless loop with the shared instrument patch")

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = {**PROXY_ENV, **MIRROR_ENV, **self.extra_env}
        # DSH's headless profile reads DEEPSEEK_API_KEY from the environment.
        patch = f" --patch {PATCH}"
        servers = getattr(self, 'mcp_servers', None) or []
        mcp_note = ''
        if servers:
            lines = []
            for server in servers:
                name = getattr(server, 'name', 'mcp')
                transport = getattr(server, 'transport', 'unknown')
                url = getattr(server, 'url', None)
                lines.append(f"- {name}: {transport} {url or ''}".rstrip())
            mcp_note = (
                "\n\nMCP servers configured for this task (config is visible, but DSH has no "
                "SSE MCP client and does not register them as native tools):\n" + "\n".join(lines)
            )
        instruction = instruction + mcp_note
        command = (
            "set -e\n"
            "cd /app 2>/dev/null || cd /\n"
            f"dsh --profile {PROFILE}{patch} {shlex.quote(instruction)}\n"
        )
        result = await environment.exec(command=command, timeout_sec=int(self.agent_timeout_sec), env=env)
        if result.return_code != 0:
            self.logger.error(f"DSH exited {result.return_code}; verifier will score the workspace as-is")
        try:
            await environment.download_dir("/root/.dsh/sessions", str(self.logs_dir / "dsh-sessions"))
        except Exception as exc:  # session logs are optional for the benchmark score
            self.logger.warning(f"could not download DSH sessions: {exc}")
        (self.logs_dir / "dsh-stdout.log").write_text(result.stdout or "")
        (self.logs_dir / "dsh-stderr.log").write_text(result.stderr or "")
        transport_failed = "TRANSPORT" in (result.stderr or "") or "TRANSPORT" in (result.stdout or "")
        # Marker, not a second exit code: `agent_exit` stays the integer DSH returned.
        graph_failed = bool(GRAPH_FAILED_RE.search((result.stdout or "") + "\n" + (result.stderr or "")))
        context.metadata = {
            "agent": "dsh",
            "plugin": "dsh-graph-loop" if not self.stock else "stock",
            "tool_policy": "preset",
            "agent_exit": result.return_code,
            "transport_failed": transport_failed,
            "graph_failed": graph_failed,
        }
