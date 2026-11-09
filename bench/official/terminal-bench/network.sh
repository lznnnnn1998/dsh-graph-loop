#!/usr/bin/env bash
# Network configuration for the Terminal-Bench harness — the single source of truth.
#
#   source bench/official/terminal-bench/network.sh          # domestic mirrors (default: cn)
#   DSH_MIRRORS=off source bench/official/terminal-bench/network.sh   # upstream sources
#   bash bench/official/terminal-bench/network.sh            # print the resolved config
#
# Consumers read this file; do not re-declare package indexes or proxy variable names
# in a script, a Dockerfile or the Python adapter:
#   - build-arm64-task.sh / build-dsh-base.sh  (build-time Dockerfile rewrites, proxy args)
#   - apply-mirrors.py                         (rewrites the copied task/base Dockerfile)
#   - run-smoke.sh / run-subset.sh             (Harbor process environment)
#   - dsh_agent.py                             (env injected into the task container)
#
# What mirrors cover: pip/uv, npm, Node downloads and Debian/Ubuntu apt sources.
# What they do not cover: Docker base images, vendor sidecars and the model API — those
# need the Docker daemon proxy and/or HTTP_PROXY (see bench/README.md, "Network setup").
#
# Proxy values are pass-through, never defaults: export them in the operator shell and
# every consumer forwards the same names. The lists below are the contract.
set -u

: "${DSH_MIRRORS:=cn}"
export DSH_MIRRORS

# Variable-name contracts (space separated; consumers loop over these).
export DSH_PROXY_VARS="HTTP_PROXY HTTPS_PROXY NO_PROXY NODE_USE_ENV_PROXY"
export DSH_BUILD_PROXY_VARS="HTTP_PROXY HTTPS_PROXY NO_PROXY"
export DSH_CONTAINER_MIRROR_VARS="PIP_INDEX_URL PIP_TRUSTED_HOST UV_DEFAULT_INDEX UV_HTTP_TIMEOUT NPM_CONFIG_REGISTRY npm_config_registry"

if [ "$DSH_MIRRORS" = "off" ]; then
  # Upstream package sources: leave the host environment untouched.
  unset PIP_INDEX_URL PIP_TRUSTED_HOST UV_DEFAULT_INDEX UV_HTTP_TIMEOUT
  unset NPM_CONFIG_REGISTRY npm_config_registry
  unset DSH_NODE_MIRROR DSH_APT_MIRROR
else
  export PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
  export PIP_TRUSTED_HOST="${PIP_TRUSTED_HOST:-pypi.tuna.tsinghua.edu.cn}"
  export UV_DEFAULT_INDEX="${UV_DEFAULT_INDEX:-$PIP_INDEX_URL}"
  export UV_HTTP_TIMEOUT="${UV_HTTP_TIMEOUT:-300}"
  export NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
  export npm_config_registry="${npm_config_registry:-$NPM_CONFIG_REGISTRY}"
  # Base URL without a version: the consumers append /v<VERSION>/node-v<VERSION>-linux.
  export DSH_NODE_MIRROR="${DSH_NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
  # http avoids a TLS bootstrap dependency in slim base images.
  export DSH_APT_MIRROR="${DSH_APT_MIRROR:-http://mirrors.tuna.tsinghua.edu.cn}"
fi

dsh_network_show() {
  printf '%-24s %s\n' "DSH_MIRRORS" "$DSH_MIRRORS"
  local name
  for name in $DSH_CONTAINER_MIRROR_VARS DSH_NODE_MIRROR DSH_APT_MIRROR; do
    printf '%-24s %s\n' "$name" "${!name:-(unset)}"
  done
  for name in $DSH_PROXY_VARS; do
    printf '%-24s %s\n' "$name" "${!name:-(unset)}"
  done
}

dsh_network_validate() {
  local failed=0 name
  if [ "$DSH_MIRRORS" = "off" ]; then
    return 0
  fi
  if [ "$DSH_MIRRORS" != "cn" ]; then
    printf 'FAIL: DSH_MIRRORS must be cn or off, got %s\n' "$DSH_MIRRORS" >&2
    failed=1
  fi
  for name in PIP_INDEX_URL PIP_TRUSTED_HOST UV_DEFAULT_INDEX NPM_CONFIG_REGISTRY \
              npm_config_registry DSH_NODE_MIRROR DSH_APT_MIRROR; do
    if [ -z "${!name:-}" ]; then
      printf 'FAIL: %s is empty in cn mode\n' "$name" >&2
      failed=1
    fi
  done
  # Contract: the Node mirror is a base URL without a version; consumers add the
  # /v<version>/node-v<version>-linux suffix themselves.
  case "${DSH_NODE_MIRROR:-}" in
    *node-v[0-9]*|*/v[0-9]*/node-v*)
      printf 'FAIL: DSH_NODE_MIRROR must be a base URL without a version: %s\n' "$DSH_NODE_MIRROR" >&2
      failed=1 ;;
  esac
  return "$failed"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  dsh_network_show
  dsh_network_validate
fi
