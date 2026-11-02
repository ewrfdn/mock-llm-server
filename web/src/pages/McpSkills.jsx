import { useEffect, useState } from "react";
import { Badge, CopyButton, EmptyState, Icon, PageHeader, Spinner } from "../components/ui.jsx";

const ORIGIN = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8787";

const MCP_CONFIG = `{
  "mcpServers": {
    "mock-llm-server": {
      "url": "${ORIGIN}/mcp"
    }
  }
}`;

const CURL_MODELS = `curl ${ORIGIN}/v1/models \\
  -H "Authorization: Bearer $MOCK_API_KEY"`;

const CURL_CHAT = `curl ${ORIGIN}/v1/chat/completions \\
  -H "Authorization: Bearer $MOCK_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "mock-fast",
    "stream": true,
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "hello"}]
  }'`;

const TOOLS = [
  { name: "get_server_info", description: "服务地址、鉴权方式、Redis 状态、词表与指标语义", mode: "只读" },
  { name: "list_models", description: "列出全部 mock 模型与指标", mode: "只读" },
  { name: "get_model", description: "按 ID 读取单个模型", mode: "只读" },
  { name: "create_model", description: "创建模型：QPM/TPM、输出范围、TPS、TTFT、可用性、缓存", mode: "写入" },
  { name: "update_model", description: "更新模型指标（只传要改的字段）", mode: "写入" },
  { name: "delete_model", description: "删除模型，保留历史统计", mode: "写入" },
  { name: "get_usage_stats", description: "读取 1h / 6h / 24h / 7d 的用量统计", mode: "只读" },
];

export default function McpSkills() {
  const [skill, setSkill] = useState(null);
  const [skillError, setSkillError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/skill")
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
        if (!cancelled) setSkill(data);
      })
      .catch((error) => {
        if (!cancelled) setSkillError(error.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <PageHeader
        title="MCP & Skills"
        description="通过 MCP 配置模型，把 Skill 丢给 Agent 让它自己学会使用这套 mock 服务。"
        actions={
          <>
            <a className="btn btn-ghost" href="/api/v1/skill/download">
              <Icon name="download" size={15} />
              下载 Skill ZIP
            </a>
            <a className="btn btn-primary" href="/api/v1/skill" target="_blank" rel="noreferrer">
              <Icon name="book" size={15} />
              查看 SKILL.md
            </a>
          </>
        }
      />

      <div className="mcp-grid">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>连接 MCP</h2>
              <p>服务端使用标准 Streamable HTTP，JSON 响应模式。</p>
            </div>
            <Badge tone="warn" dot>
              暂不鉴权
            </Badge>
          </div>

          <div className="endpoint-box">
            <div>
              <span>Streamable HTTP URL</span>
              <code>{ORIGIN}/mcp</code>
            </div>
            <CopyButton text={`${ORIGIN}/mcp`} label="复制地址" />
          </div>

          <div className="code-head">
            <span>客户端配置（Claude Desktop / Cursor 等）</span>
            <CopyButton text={MCP_CONFIG} />
          </div>
          <pre className="code-block">{MCP_CONFIG}</pre>

          <div className="alert alert-warn">
            <Icon name="alert" size={16} />
            <span>
              MCP 端点当前不校验 API Key，任何能访问该端口的客户端都可以创建/修改模型。请默认只监听 <code>127.0.0.1</code>
              ，远程部署时在反向代理层加白名单。
            </span>
          </div>

          <p className="hint">
            仅支持 stdio 的客户端，可用 <code>npx mcp-remote {ORIGIN}/mcp</code> 转接。推理接口 <code>/v1</code> 仍然需要 API Key。
          </p>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>MCP Tools</h2>
              <p>模型配置通过 MCP 完成，无需打开管理台。</p>
            </div>
            <Badge tone="accent">{TOOLS.length} 个</Badge>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>说明</th>
                  <th>类型</th>
                </tr>
              </thead>
              <tbody>
                {TOOLS.map((tool) => (
                  <tr key={tool.name}>
                    <td>
                      <code>{tool.name}</code>
                    </td>
                    <td className="muted">{tool.description}</td>
                    <td>
                      <Badge tone={tool.mode === "只读" ? "default" : "accent"}>{tool.mode}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="card skill-card">
        <div className="card-head">
          <div>
            <h2>Skill：{skill?.name || "mock-llm-server"}</h2>
            <p>
              Agent 可读的接入说明，包含 MCP 工具参数、指标语义、OpenAI 兼容 API 与限流行为。
              <a href="/api/v1/skill/download"> 下载 ZIP</a> 后放入客户端的 skills 目录。
            </p>
          </div>
          <div className="row">
            <CopyButton text={skill?.content || ""} label="复制全文" />
          </div>
        </div>

        {loading ? (
          <div className="loading-block">
            <Spinner size={18} /> 加载 SKILL.md…
          </div>
        ) : skillError ? (
          <EmptyState icon="alert" title="读取 Skill 失败" description={skillError} />
        ) : (
          <pre className="skill-content">{skill?.content}</pre>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>OpenAI 兼容调用</h2>
            <p>Base URL 固定为 <code>{ORIGIN}/v1</code>，使用任意 API Key 作为 Bearer Token。</p>
          </div>
        </div>
        <div className="code-grid">
          <div>
            <div className="code-head">
              <span>列出模型</span>
              <CopyButton text={CURL_MODELS} />
            </div>
            <pre className="code-block small">{CURL_MODELS}</pre>
          </div>
          <div>
            <div className="code-head">
              <span>流式对话</span>
              <CopyButton text={CURL_CHAT} />
            </div>
            <pre className="code-block small">{CURL_CHAT}</pre>
          </div>
        </div>
      </section>
    </>
  );
}
