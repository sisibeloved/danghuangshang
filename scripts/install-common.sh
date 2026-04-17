#!/bin/bash
# ============================================
# danghuangshang 安装脚本共享函数
# ============================================

# 颜色常量
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# 确保 jq 已安装
check_jq() {
  if ! command -v jq &>/dev/null; then
    echo -e "${YELLOW}⚠${NC} jq 未安装，正在安装..."
    if command -v apt &>/dev/null; then
      sudo apt update && sudo apt install -y jq
    elif command -v brew &>/dev/null; then
      brew install jq
    else
      echo -e "${RED}✗${NC} 请手动安装 jq"
      exit 1
    fi
    echo -e "${GREEN}✓${NC} jq 已安装"
  else
    echo -e "  ${GREEN}✓${NC} jq 已安装"
  fi
}

# 确保 OpenClaw 已安装
check_openclaw() {
  if command -v openclaw &>/dev/null; then
    OPENCLAW_VERSION=$(openclaw --version 2>/dev/null || echo "unknown")
    echo -e "  ${GREEN}✓${NC} OpenClaw 已安装：$OPENCLAW_VERSION"
  else
    echo -e "  ${RED}✗${NC} OpenClaw 未安装"
    echo "  正在安装 OpenClaw..."
    npm install -g openclaw
    echo -e "  ${GREEN}✓${NC} OpenClaw 已安装"
  fi
}

# 检测 OpenClaw 配置文件路径
# 设置变量：OPENCLAW_CONFIG_FILE（找到则为路径，否则为空）
detect_config_path() {
  OPENCLAW_CONFIG_FILE=""
  for _cfg in "$HOME/.openclaw/openclaw.json" "$HOME/.clawdbot/openclaw.json"; do
    if [ -f "$_cfg" ]; then
      OPENCLAW_CONFIG_FILE="$_cfg"
      break
    fi
  done
}

# 智能检测并配置 LLM API
# 检测已有 OpenClaw 配置中的模型设定，支持复用
# 设置变量：LLM_API_URL, LLM_API_KEY, LLM_MODEL_ID, LLM_API_FORMAT, REUSE_MODELS
configure_llm() {
  detect_config_path

  REUSE_MODELS=false

  if [ -n "$OPENCLAW_CONFIG_FILE" ]; then
    # 检测真实 provider：baseUrl 存在且不是占位符
    # 兼容 apiKey / authHeader / 纯环境变量 等多种认证方式
    _real_providers=$(jq -r '
      [.models.providers | to_entries[] |
        select(.value.baseUrl // "" |
          . != "" and (. | startswith("https://your-") | not))
      ] | length
    ' "$OPENCLAW_CONFIG_FILE" 2>/dev/null || echo 0)

    if [ "$_real_providers" -gt 0 ]; then
      _provider_names=$(jq -r '.models.providers | keys | join(", ")' "$OPENCLAW_CONFIG_FILE" 2>/dev/null || echo "unknown")
      echo ""
      echo -e "  ${GREEN}✓${NC} 检测到现有 OpenClaw 模型配置"
      echo -e "  ${CYAN}  提供者：${_provider_names}${NC}"
      echo -e "  ${CYAN}  配置文件：${OPENCLAW_CONFIG_FILE}${NC}"
      echo ""
      read -p "  是否复用现有模型配置？(Y/n) " REUSE_CHOICE
      if [ "$REUSE_CHOICE" != "n" ] && [ "$REUSE_CHOICE" != "N" ]; then
        REUSE_MODELS=true
        echo -e "  ${GREEN}✓${NC} 将复用现有模型配置"
      fi
    fi
  fi

  if [ "$REUSE_MODELS" = "false" ]; then
    echo ""
    echo "  常用 API 提供商："
    echo "  - DeepSeek: https://platform.deepseek.com"
    echo "  - OpenAI: https://platform.openai.com"
    echo "  - Anthropic: https://console.anthropic.com"
    echo "  - OpenRouter: https://openrouter.ai"
    echo "  - DashScope (通义千问): https://dashscope.aliyun.com"
    echo ""

    read -p "  API Base URL (如 https://api.deepseek.com/v1): " LLM_API_URL
    read -s -p "  API Key: " LLM_API_KEY
    echo ""
    read -p "  模型 ID (如 deepseek-chat, gpt-4o, claude-sonnet-4-20250514): " LLM_MODEL_ID
    echo ""

    if [ -z "$LLM_API_URL" ] || [ -z "$LLM_API_KEY" ] || [ -z "$LLM_MODEL_ID" ]; then
      echo -e "${RED}✗ API 配置不能为空${NC}"
      exit 1
    fi

    LLM_API_FORMAT="openai-completions"
    if echo "$LLM_API_URL" | grep -qi "anthropic"; then
      LLM_API_FORMAT="anthropic-messages"
    fi

    echo -e "  ${GREEN}✓${NC} API 配置完成"
  fi
}

# 将 LLM 配置注入到 JSON 配置文件（jq 操作）
# 参数: $1 = 配置文件路径
inject_llm_config() {
  local config_file="$1"
  local provider_key
  provider_key=$(jq -r '.models.providers | keys[0]' "$config_file")

  jq --arg url "$LLM_API_URL" \
     --arg key "$LLM_API_KEY" \
     --arg format "$LLM_API_FORMAT" \
     --arg provider "$provider_key" \
    '.models.providers[$provider].baseUrl = $url |
     .models.providers[$provider].apiKey = $key |
     .models.providers[$provider].api = $format' \
    "$config_file" > "${config_file}.tmp" && mv "${config_file}.tmp" "$config_file"
  echo -e "    ${GREEN}✓${NC} LLM 配置已注入（提供者：$provider_key）"
}

# 替换模板占位符：workspace 路径、model provider 引用
# 参数: $1 = 配置文件路径, $2 = 实际 provider 名（可选，复用时从文件读取）
fix_template_placeholders() {
  local config_file="$1"
  local actual_home="$HOME"

  # 1. 替换 workspace 路径中的 $HOME 和 /home/YOUR_USERNAME
  jq --arg home "$actual_home" '
    # agents.defaults.workspace
    if .agents.defaults.workspace then
      .agents.defaults.workspace |= (
        gsub("/home/YOUR_USERNAME"; $home) |
        gsub("\\$HOME"; $home)
      )
    else . end
    |
    # 每个 agent 的 workspace
    if .agents.list then
      .agents.list |= map(
        if .workspace then
          .workspace |= (
            gsub("/home/YOUR_USERNAME"; $home) |
            gsub("\\$HOME"; $home)
          )
        else . end
      )
    else . end
  ' "$config_file" > "${config_file}.tmp" && mv "${config_file}.tmp" "$config_file"

  # 2. 替换 model 引用中的 provider 名称
  # 找到配置文件中第一个真实 provider（有非占位 baseUrl 的）
  local real_provider
  real_provider=$(jq -r '
    [.models.providers | to_entries[] |
      select(.value.baseUrl // "" | . != "" and (. | startswith("https://your-") | not))
    ][0].key // "your-provider"
  ' "$config_file" 2>/dev/null)

  if [ "$real_provider" != "your-provider" ]; then
    jq --arg old "your-provider/" --arg new "$real_provider/" '
      # agents.defaults.model
      if .agents.defaults.model then
        .agents.defaults.model |= (
          if .primary then .primary |= gsub($old; $new) else . end |
          if .secondary then .secondary |= gsub($old; $new) else . end
        )
      else . end
      |
      # 每个 agent 的 model
      if .agents.list then
        .agents.list |= map(
          if .model then
            .model |= (
              if .primary then .primary |= gsub($old; $new) else . end |
              if .secondary then .secondary |= gsub($old; $new) else . end
            )
          else . end
        )
      else . end
    ' "$config_file" > "${config_file}.tmp" && mv "${config_file}.tmp" "$config_file"
  fi
}
