import https from 'node:https';

// Default Yandex GPT models (Yandex Cloud Foundation Models)
export const YANDEX_GPT_MODELS = [
  'yandexgpt-lite',
  'yandexgpt',
  'yandexgpt-32k',
] as const;

// Native Yandex Cloud Foundation Models REST endpoint.
// Supports API keys (including AI Studio keys AQVN...) via `Authorization: Api-Key`.
const YANDEX_LLM_ENDPOINT = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

/**
 * Retrieves Yandex GPT API key from environment secrets.
 * Supports several common naming conventions.
 */
export function getYandexGptApiKey(): { apiKey: string; sourceVar: string } | null {
  const knownKeys = [
    'YANDEX_GPT_API_KEY',
    'YANDEXGPT_API_KEY',
    'YANDEX_AI_STUDIO_API_KEY',
    'YANDEX_AI_API_KEY',
    'YC_API_KEY',
    'YANDEX_CLOUD_API_KEY',
  ];

  for (const key of knownKeys) {
    const val = process.env[key];
    if (val && typeof val === 'string' && val.trim().length > 5) {
      return { apiKey: val.trim(), sourceVar: key };
    }
  }

  // Dynamic scan of any env var containing "yandex" + "key"/"token"
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (!envVal || typeof envVal !== 'string' || envVal.trim().length < 5) continue;
    const lowerKey = envKey.toLowerCase();
    if (
      lowerKey.includes('yandex') &&
      (lowerKey.includes('key') || lowerKey.includes('token') || lowerKey.includes('secret')) &&
      !lowerKey.includes('model') &&
      !lowerKey.includes('folder')
    ) {
      return { apiKey: envVal.trim(), sourceVar: envKey };
    }
  }

  return null;
}

/**
 * Retrieves the Yandex Cloud folder ID used to build the modelUri (gpt://<folder_id>/<model>).
 * Falls back to common env var names.
 */
export function getYandexGptFolderId(): string | null {
  const knownKeys = ['YANDEX_GPT_FOLDER_ID', 'YC_FOLDER_ID', 'FOLDER_ID'];

  for (const key of knownKeys) {
    const val = process.env[key];
    if (val && typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }

  return null;
}

/**
 * Checks if Yandex GPT is configured in environment secrets
 */
export function isYandexGptConfigured(): boolean {
  return Boolean(getYandexGptApiKey() && getYandexGptFolderId());
}

/**
 * Custom HTTPS Request helper with timing diagnostics
 */
function httpsRequest(
  url: string,
  options: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
  }
): Promise<{ statusCode: number; headers: any; data: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const postData = options.body;
    const requestTimeout = options.timeout || 40000;
    const startedAt = Date.now();

    const logTiming = (stage: string) => {
      console.log(
        `[YandexGPT] ${options.method} ${parsedUrl.hostname} stage="${stage}" +${Date.now() - startedAt}ms`
      );
    };

    const reqOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: options.method,
      headers: options.headers || {},
      timeout: requestTimeout,
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.setEncoding('utf8');
      logTiming('response-start');

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        logTiming('response-end');
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          data,
        });
      });
    });

    req.on('lookup', () => logTiming('dns-lookup'));
    req.on('connect', () => logTiming('tcp-connect'));
    req.on('secureConnect', () => logTiming('tls-secure-connect'));

    req.on('timeout', () => {
      logTiming(`timeout(${requestTimeout}ms)`);
      req.destroy();
      reject(new Error(`Request to ${url} timed out`));
    });

    req.on('error', (err) => {
      console.log(`[YandexGPT] ${options.method} ${parsedUrl.hostname} error:`, err?.message || err);
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }

    req.end();
  });
}

export interface YandexGptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface YandexGptCompletionResponse {
  result?: {
    alternatives?: Array<{
      message?: {
        role: string;
        text: string;
      };
      status?: string;
    }>;
    usage?: any;
    modelVersion?: string;
  };
}

/**
 * Sends a chat completion request to Yandex GPT via the native
 * Yandex Cloud Foundation Models REST API.
 * Endpoint: POST https://llm.api.cloud.yandex.net/foundationModels/v1/completion
 */
export async function sendYandexGptCompletion(
  messages: YandexGptMessage[],
  modelName: string = process.env.YANDEX_GPT_MODEL || 'yandexgpt-lite'
): Promise<{ text: string; modelUsed: string } | null> {
  const keyInfo = getYandexGptApiKey();
  if (!keyInfo) {
    console.warn('[YandexGPT] No API key found in environment. Please set YANDEX_GPT_API_KEY in secrets.');
    return null;
  }

  const folderId = getYandexGptFolderId();
  if (!folderId) {
    console.warn(
      '[YandexGPT] No folder ID found in environment. Please set YANDEX_GPT_FOLDER_ID in secrets.'
    );
    return null;
  }

  const modelUri = `gpt://${folderId}/${modelName}`;

  const makeRequest = async () => {
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const sysChars = messages.find((m) => m.role === 'system')?.content?.length || 0;
    console.log(
      `[YandexGPT] Sending completion (model=${modelName}, modelUri=${modelUri}, messages=${messages.length}, ` +
        `chars=${totalChars}, systemChars=${sysChars}, source=${keyInfo.sourceVar})`
    );
    return await httpsRequest(YANDEX_LLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Api-Key ${keyInfo.apiKey}`,
      },
      body: JSON.stringify({
        modelUri,
        completionOptions: {
          stream: false,
          temperature: 0.1,
          maxTokens: 1024,
        },
        messages: messages.map((m) => ({
          role: m.role,
          text: m.content,
        })),
      }),
    });
  };

  try {
    const response = await makeRequest();

    if (response.statusCode < 200 || response.statusCode >= 300) {
      console.warn(`[YandexGPT] API returned error status ${response.statusCode}:`, response.data);
      return null;
    }

    const data: YandexGptCompletionResponse = JSON.parse(response.data);
    const content = data.result?.alternatives?.[0]?.message?.text?.trim() || '';

    if (!content) {
      console.warn('[YandexGPT] Empty message text in completion response');
      return null;
    }

    return {
      text: content,
      modelUsed: modelName,
    };
  } catch (err: any) {
    console.error(`[YandexGPT] Error during completion request (${modelName}):`, err?.message || err);
    return null;
  }
}