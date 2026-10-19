
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const NIM_API_BASE = (
  process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1'
).replace(/\/+$/, '');

const NIM_API_KEY = process.env.NIM_API_KEY;
const DEFAULT_MODEL = 'z-ai/glm-5.3';

const ENABLE_THINKING_MODE =
  process.env.ENABLE_THINKING_MODE === 'true';

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'deepseek-ai/deepseek-v4.1-flash',
  'gpt-4': DEFAULT_MODEL,
  'gpt-4-turbo': DEFAULT_MODEL,
  'gpt-4o': DEFAULT_MODEL,
  'claude-3-opus': DEFAULT_MODEL,
  'claude-3-sonnet': DEFAULT_MODEL,
  'gemini-pro': DEFAULT_MODEL,
  'z-ai/glm-5.3': DEFAULT_MODEL
};

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

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Proxy is running',
    model: DEFAULT_MODEL
  });
});

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

async function getErrorDetails(error) {
  const data = error.response?.data;

  if (
    data &&
    typeof data === 'object' &&
    typeof data[Symbol.asyncIterator] === 'function'
  ) {
    try {
      let body = '';
      for await (const chunk of data) {
        body += chunk.toString();
      }
      return body || 'Empty error response';
    } catch {
      return 'Unable to read upstream error response';
    }
  }

  if (typeof data === 'string') {
    return data;
  }

  try {
    return JSON.stringify(data ?? error.message);
  } catch {
    return error.message || 'Unknown error';
  }
}

app.post('/v1/chat/completions', async (req, res) => {
  const startedAt = Date.now();

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
    console.error('NIM_API_KEY is missing');

    return res.status(500).json({
      error: {
        message: 'NIM_API_KEY is missing from server configuration',
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

  const requestedModel = model || DEFAULT_MODEL;
  const nimModel = MODEL_MAPPING[requestedModel] || DEFAULT_MODEL;
  const clientWantsStream = stream === true;

  console.log(`Routing: ${requestedModel} -> ${nimModel}`);
  console.log('NVIDIA endpoint:', `${NIM_API_BASE}/chat/completions`);
  console.log('Client wants stream:', clientWantsStream);

  const nimRequest = {
    model: nimModel,
    messages,
    temperature: temperature ?? 0.8,
    max_tokens: max_tokens ?? 4096,
    stream: clientWantsStream
  };

  if (top_p !== undefined) nimRequest.top_p = top_p;
  if (stop !== undefined) nimRequest.stop = stop;
  if (frequency_penalty !== undefined) {
    nimRequest.frequency_penalty = frequency_penalty;
  }
  if (presence_penalty !== undefined) {
    nimRequest.presence_penalty = presence_penalty;
  }
  if (seed !== undefined) nimRequest.seed = seed;

  if (ENABLE_THINKING_MODE) {
    nimRequest.chat_template_kwargs = { thinking: true };
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
        timeout: 600000
      }
    );

    console.log('NVIDIA response status:', nimResponse.status);
    console.log('NVIDIA request succeeded');

    if (clientWantsStream) {
      res.status(nimResponse.status);
      res.setHeader(
        'Content-Type',
        'text/event-stream; charset=utf-8'
      );
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      let firstChunkLogged = false;

      nimResponse.data.on('data', () => {
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          console.log(
            'First NVIDIA stream chunk received after',
            Date.now() - startedAt,
            'ms'
          );
        }
      });

      nimResponse.data.on('error', (error) => {
        console.error('NVIDIA stream error:', error.message);

        if (!res.writableEnded) {
          res.end();
        }
      });

      // IMPORTANT:
      // Listen to the response closing, not the request closing.
      // The request body can finish before the response stream does.
      res.on('close', () => {
        if (!res.writableEnded && !nimResponse.data.destroyed) {
          console.log('Client disconnected; stopping NVIDIA stream');
          nimResponse.data.destroy();
        }
      });

      nimResponse.data.pipe(res);
      return;
    }

    console.log(
      'Returning non-stream JSON response after',
      Date.now() - startedAt,
      'ms'
    );

    return res.status(nimResponse.status).json(nimResponse.data);

  } catch (error) {
    const status = error.response?.status || 502;
    const details = await getErrorDetails(error);

    console.error('=== NVIDIA REQUEST FAILED ===');
    console.error('Message:', error.message);
    console.error('Status:', error.response?.status ?? 'No HTTP response');
    console.error('Error code:', error.code || 'N/A');
    console.error('Response body:', details);
    console.error('Elapsed:', Date.now() - startedAt, 'ms');
    console.error('=============================');

    if (res.headersSent) {
      if (!res.writableEnded) res.end();
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

app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Route not found: ${req.method} ${req.path}`,
      type: 'not_found',
      code: 404
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy server listening on port ${PORT}`);
  console.log(`NVIDIA API base: ${NIM_API_BASE}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`Thinking mode: ${ENABLE_THINKING_MODE}`);
});

// Keep-alive
setInterval(() => {
  axios
    .get(`http://localhost:${PORT}/health`, { timeout: 10000 })
    .catch((error) => {
      console.error('Keep-alive check failed:', error.message);
    });
}, 25000);
