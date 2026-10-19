
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// NVIDIA API 設定
const NIM_API_BASE = (
  process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1'
).replace(/\/+$/, '');

const NIM_API_KEY = process.env.NIM_API_KEY;

// 是否啟用模型思考模式；預設關閉
const ENABLE_THINKING_MODE =
  process.env.ENABLE_THINKING_MODE === 'true';

// 所有模型名稱最終都會使用 GLM-5.3
const DEFAULT_MODEL = 'z-ai/glm-5.3';

const MODEL_MAPPING = {
  'gpt-3.5-turbo': DEFAULT_MODEL,
  'gpt-4': DEFAULT_MODEL,
  'gpt-4-turbo': DEFAULT_MODEL,
  'gpt-4o': DEFAULT_MODEL,
  'claude-3-opus': DEFAULT_MODEL,
  'claude-3-sonnet': DEFAULT_MODEL,
  'gemini-pro': DEFAULT_MODEL,
  'z-ai/glm-5.3': DEFAULT_MODEL
};

// CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-api-key',
    'api-key'
  ],
  credentials: false
}));

app.use(express.json({ limit: '10mb' }));

// 基本健康檢查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Proxy is running',
    model: DEFAULT_MODEL
  });
});

// OpenAI 相容模型列表
app.get('/v1/models', (req, res) => {
  const models = [...new Set([
    DEFAULT_MODEL,
    ...Object.keys(MODEL_MAPPING)
  ])];

  res.json({
    object: 'list',
    data: models.map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'nvidia'
    }))
  });
});

// 把上游錯誤回應轉成可讀文字
async function getErrorDetails(error) {
  const response = error.response;

  if (!response) {
    return error.message || 'Unknown network error';
  }

  const data = response.data;

  if (data && typeof data === 'object' &&
      typeof data[Symbol.asyncIterator] === 'function') {
    try {
      let body = '';

      for await (const chunk of data) {
        body += chunk.toString();
      }

      return body || 'Empty error response';
    } catch (readError) {
      return 'Unable to read upstream error response';
    }
  }

  if (typeof data === 'string') {
    return data;
  }

  try {
    return JSON.stringify(data);
  } catch {
    return String(data || 'Empty error response');
  }
}

// 聊天補全 API
app.post('/v1/chat/completions', async (req, res) => {
  console.log('\n=== Incoming Request ===');
  console.log('Model:', req.body?.model);
  console.log('Stream:', req.body?.stream);
  console.log('Messages:', req.body?.messages?.length);
  console.log('Origin:', req.headers.origin);
  console.log(
    'Auth header present:',
    Boolean(req.headers.authorization)
  );

  if (!NIM_API_KEY) {
    console.error('NIM_API_KEY is missing in environment variables');

    return res.status(500).json({
      error: {
        message: 'Server configuration error: NIM_API_KEY is missing',
        type: 'proxy_error',
        code: 500
      }
    });
  }

  const {
    model,
    messages,
    temperature,
    max_tokens,
    stream,
    top_p,
    stop,
    frequency_penalty,
    presence_penalty,
    seed
  } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: 'messages must be a non-empty array',
        type: 'invalid_request_error',
        code: 400
      }
    });
  }

  // 保留傳入的模型名稱供日誌查看；
  // 實際上統一使用 NVIDIA GLM-5.3
  const requestedModel = model || DEFAULT_MODEL;
  const nimModel =
    MODEL_MAPPING[requestedModel] || DEFAULT_MODEL;

  const clientWantsStream = stream === true;

  console.log(`Routing: ${requestedModel} -> ${nimModel}`);
  console.log('NVIDIA endpoint:', `${NIM_API_BASE}/chat/completions`);
  console.log('Client wants stream:', clientWantsStream);

  // 建立 NVIDIA 請求
  const nimRequest = {
    model: nimModel,
    messages,
    temperature: temperature ?? 0.8,
    max_tokens: max_tokens ?? 4096,
    stream: clientWantsStream
  };

  // 僅傳遞有提供的可選參數
  if (top_p !== undefined) {
    nimRequest.top_p = top_p;
  }

  if (stop !== undefined) {
    nimRequest.stop = stop;
  }

  if (frequency_penalty !== undefined) {
    nimRequest.frequency_penalty = frequency_penalty;
  }

  if (presence_penalty !== undefined) {
    nimRequest.presence_penalty = presence_penalty;
  }

  if (seed !== undefined) {
    nimRequest.seed = seed;
  }

  // NVIDIA API 使用頂層 chat_template_kwargs，
  // 不使用原本的 extra_body 包裝
  if (ENABLE_THINKING_MODE) {
    nimRequest.chat_template_kwargs = {
      thinking: true
    };
  }

  try {
    console.log('Sending request to NVIDIA...');

    const nimResponse = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: clientWantsStream
            ? 'text/event-stream'
            : 'application/json'
        },
        responseType: clientWantsStream ? 'stream' : 'json',
        timeout: 600000,
        validateStatus: (status) => status >= 200 && status < 300
      }
    );

    console.log('NVIDIA response status:', nimResponse.status);
    console.log('NVIDIA request succeeded');

    // 串流模式：將 NVIDIA 的 SSE 資料直接轉發給客戶端
    if (clientWantsStream) {
      res.status(nimResponse.status);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      nimResponse.data.on('error', (error) => {
        console.error('NVIDIA stream error:', error.message);

        if (!res.writableEnded) {
          res.end();
        }
      });

      req.on('close', () => {
        if (!res.writableEnded && !nimResponse.data.destroyed) {
          nimResponse.data.destroy();
        }
      });

      nimResponse.data.pipe(res);
      return;
    }

    // 非串流模式：直接回傳 JSON
    console.log('Returning non-stream JSON response');
    return res.status(nimResponse.status).json(nimResponse.data);

  } catch (error) {
    const status = error.response?.status || 502;
    const details = await getErrorDetails(error);

    console.error('=== NVIDIA REQUEST FAILED ===');
    console.error('Message:', error.message);
    console.error('Status:', error.response?.status ?? 'No HTTP response');
    console.error('Error code:', error.code || 'N/A');
    console.error('Response body:', details);
    console.error('=============================');

    if (res.headersSent) {
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    return res.status(status).json({
      error: {
        message: 'NVIDIA API request failed',
        type: 'proxy_error',
        code: status,
        details
      }
    });
  }
});

// 未匹配的路由
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Route not found: ${req.method} ${req.path}`,
      type: 'not_found',
      code: 404
    }
  });
});

// 啟動服務
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy server listening on port ${PORT}`);
  console.log(`NVIDIA API base: ${NIM_API_BASE}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`Thinking mode: ${ENABLE_THINKING_MODE}`);
});

// 定期喚醒服務，避免閒置
setInterval(() => {
  axios
    .get(`http://localhost:${PORT}/health`, {
      timeout: 10000
    })
    .catch((error) => {
      console.error('Keep-alive check failed:', error.message);
    });
}, 25000);
