const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));

app.options('*', cors());

app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'z-ai/glm-5.1',
  'gpt-4': 'deepseek-ai/deepseek-v3.2',
  'gpt-4-turbo': 'deepseek-ai/deepseek-v3.1'
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    console.log('Request details:', {
      model,
      messageCount: messages?.length,
      stream,
      maxTokens: max_tokens
    });
    
    const nimModel = MODEL_MAPPING[model] || MODEL_MAPPING['gpt-3.5-turbo'];
    
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.8,
      max_tokens: max_tokens || 4096,
      stream: stream || false
    };
    
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      timeout: 180000,
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    if (stream) {
      // Set SSE headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      // Pipe the stream directly
      response.data.on('data', (chunk) => {
        res.write(chunk);
      });
      
      response.data.on('end', () => {
        res.end();
        console.log('Stream completed in', Date.now() - startTime, 'ms');
      });
      
      response.data.on('error', (error) => {
        console.error('Stream error:', error);
        res.end();
      });
      
    } else {
      // Non-streaming response
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => ({
          index: choice.index,
          message: choice.message,
          finish_reason: choice.finish_reason
        })),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      res.json(openaiResponse);
    }
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('=== ERROR ===');
    console.error('Duration:', duration, 'ms');
    console.error('Message:', error.message);
    console.error('Code:', error.code);
    console.error('Status:', error.response?.status);
    console.error('Data:', error.response?.data);
    
    if (!res.headersSent) {
      res.status(error.response?.status || 500).json({
        error: {
          message: error.message || 'Internal server error',
          type: 'invalid_request_error',
          code: error.response?.status || 500
        }
      });
    }
  }
});

app.get('/test-nvidia', async (req, res) => {
  try {
    const start = Date.now();
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, {
      model: 'deepseek-ai/deepseek-v3.2',
      messages: [{role: 'user', content: 'Hi'}],
      max_tokens: 50
    }, {
      timeout: 180000,
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    const duration = Date.now() - start;
    res.json({ success: true, duration: `${duration}ms`, data: response.data });
  } catch (error) {
    res.json({ 
      success: false, 
      error: error.message,
      details: error.response?.data 
    });
  }
});

app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});