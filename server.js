const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Explicit CORS — handles preflight properly
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'api-key'],
  credentials: false
}));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

const MODEL_MAPPING = {
  'gpt-3.5-turbo':  'z-ai/glm-5.1',
  'gpt-4':          'deepseek-ai/deepseek-v4-pro',
  'gpt-4-turbo':    'deepseek-ai/deepseek-v3.1',
  'gpt-4o':         'deepseek-ai/deepseek-v3.1',
  'claude-3-opus':  'openai/gpt-oss-120b',
  'claude-3-sonnet':'openai/gpt-oss-20b',
  'gemini-pro':     'qwen/qwen3-next-80b-a3b-thinking'
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model, object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

app.post('/v1/chat/completions', async (req, res) => {
  // ✅ Log everything so you can see what Janitor AI is actually sending
  console.log('=== Incoming Request ===');
  console.log('Model:', req.body.model);
  console.log('Stream:', req.body.stream);
  console.log('Messages:', req.body.messages?.length);
  console.log('Origin:', req.headers.origin);
  console.log('Auth header present:', !!req.headers.authorization);

  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    const clientWantsStream = stream === true;

    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      const modelLower = (model || '').toLowerCase();
      if (modelLower.includes('gpt-4') || modelLower.includes('claude-opus') || modelLower.includes('405b')) {
        nimModel = 'meta/llama-3.1-405b-instruct';
      } else if (modelLower.includes('claude') || modelLower.includes('gemini') || modelLower.includes('70b')) {
        nimModel = 'meta/llama-3.1-70b-instruct';
      } else {
        nimModel = 'meta/llama-3.1-8b-instruct';
      }
    }

    console.log(`Routing: ${model} -> ${nimModel}`);

    // ✅ Set headers without flushing yet for non-streaming clients
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (clientWantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders(); // Only flush early for SSE — keeps connection alive during NIM wait
    }

    // ✅ Start heartbeat only for streaming clients
    let heartbeat;
    if (clientWantsStream) {
      heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    }

    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature || 0.8,
      max_tokens: max_tokens || 4096,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: true
    };

    let nimResponse;
    try {
      nimResponse = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'stream',
        timeout: 300000
      });
    } catch (err) {
      if (heartbeat) clearInterval(heartbeat);
      console.error('NIM request failed:', err.message, '| Status:', err.response?.status, '| Code:', err.code);

      const errorMsg = `[Proxy error: ${err.message}]`;
      if (clientWantsStream) {
        const errChunk = {
          id: `chatcmpl-err-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: errorMsg }, finish_reason: 'stop' }]
        };
        res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.status(err.response?.status || 500).json({
          error: { message: err.message, type: 'proxy_error', code: err.response?.status || 500 }
        });
      }
      return;
    }

    let collectedContent = '';
    let buffer = '';
    let reasoningStarted = false;

    nimResponse.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      lines.forEach(line => {
        if (!line.startsWith('data: ')) return;

        if (line.includes('[DONE]')) {
          if (heartbeat) clearInterval(heartbeat);
          if (clientWantsStream) res.write('data: [DONE]\n\n');
          return;
        }

        try {
          const data = JSON.parse(line.slice(6));
          if (data.choices?.[0]?.delta) {
            const reasoning = data.choices[0].delta.reasoning_content;
            const content = data.choices[0].delta.content;

            if (SHOW_REASONING) {
              let combined = '';
              if (reasoning && !reasoningStarted) { combined = '<think>\n' + reasoning; reasoningStarted = true; }
              else if (reasoning) { combined = reasoning; }
              if (content && reasoningStarted) { combined += '</think>\n\n' + content; reasoningStarted = false; }
              else if (content) { combined += content; }
              if (combined) { data.choices[0].delta.content = combined; delete data.choices[0].delta.reasoning_content; }
            } else {
              data.choices[0].delta.content = content || '';
              delete data.choices[0].delta.reasoning_content;
            }

            if (clientWantsStream) {
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } else {
              collectedContent += data.choices[0].delta.content || '';
            }
          }
        } catch (e) { /* skip malformed chunk */ }
      });
    });

    nimResponse.data.on('end', () => {
      if (heartbeat) clearInterval(heartbeat);
      if (!clientWantsStream) {
        res.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: collectedContent },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
      } else {
        res.end();
      }
    });

    nimResponse.data.on('error', (err) => {
      if (heartbeat) clearInterval(heartbeat);
      console.error('Stream error:', err.message);
      res.end();
    });

  } catch (error) {
    console.error('Unhandled proxy error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: error.message, type: 'invalid_request_error', code: 500 }
      });
    }
  }
});

app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found`, type: 'invalid_request_error', code: 404 } });
});

setInterval(() => {
  axios.get(`http://localhost:${PORT}/health`).catch(() => {});
}, 25000);

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});