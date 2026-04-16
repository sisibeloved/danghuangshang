#!/bin/bash
# 向后兼容包装 — 实际逻辑已移至 scripts/install-lite.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/scripts/install-lite.sh" "$@"
