import { Buffer } from "node:buffer";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }
    const errHandler = (err) => {
      console.error(err);
      return new Response(err.message, fixCors({ status: err.status ?? 500 }));
    };
    try {
      const auth = request.headers.get("Authorization");
      const apiKey = auth?.split(" ")[1];
      const assert = (success) => {
        if (!success) {
          throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
        }
      };
      const { pathname } = new URL(request.url);
      switch (true) {
        case pathname.endsWith("/chat/completions"):
          assert(request.method === "POST");
          return handleCompletions(await request.json(), apiKey)
            .catch(errHandler);
        case pathname.endsWith("/embeddings"):
          assert(request.method === "POST");
          return handleEmbeddings(await request.json(), apiKey)
            .catch(errHandler);
        case pathname.endsWith("/models"):
          assert(request.method === "GET");
          return handleModels(apiKey)
            .catch(errHandler);
        case pathname.endsWith("/images/generations"):
        case pathname.endsWith("/images/edits"):
          assert(request.method === "POST");
          return handleImages(request, apiKey, pathname)
            .catch(errHandler);
        case pathname.endsWith("/audio/transcriptions"):
          assert(request.method === "POST");
          return handleAudioTranscription(request, apiKey, { task: "transcribe" })
            .catch(errHandler);
        case pathname.endsWith("/audio/translations"):
          assert(request.method === "POST");
          return handleAudioTranscription(request, apiKey, { task: "translate" })
            .catch(errHandler);
        default:
          throw new HttpError("404 Not Found", 404);
      }
    } catch (err) {
      return errHandler(err);
    }
  }
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

class ApiKeyManager {
  constructor(apiKeyString) {
    this.keys = apiKeyString ? apiKeyString.split(',').map(k => k.trim()).filter(k => k) : [];
    this.currentIndex = 0;
  }

  getCurrent() {
    return this.keys.length > 0 ? this.keys[this.currentIndex] : null;
  }

  moveToNext() {
    if (this.keys.length > 1) {
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      return true;
    }
    return false;
  }

  getTotalCount() {
    return this.keys.length;
  }

  hasMultipleKeys() {
    return this.keys.length > 1;
  }
}

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { headers, status, statusText };
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";
const GEMINI_RETRY_COUNT = 5;
const GEMINI_RETRY_STATUS = 503;
const GEMINI_RETRY_BASE_DELAY_MS = 500;
const GEMINI_RETRY_MAX_DELAY_MS = 5000;
const describeRequest = (url, init) => `${(init?.method ?? "GET").toUpperCase()} ${url}`;

const sleep = (ms) => ms > 0
  ? new Promise(resolve => setTimeout(resolve, ms))
  : Promise.resolve();

const clampDelay = (ms) => Math.min(Math.max(ms ?? 0, 0), GEMINI_RETRY_MAX_DELAY_MS);
const parseRetryAfter = (value) => {
  if (!value) { return; }
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return date - Date.now();
  }
};
const getRetryDelay = (retryAfter, attempt) => {
  const parsed = parseRetryAfter(retryAfter);
  if (parsed !== undefined) {
    return clampDelay(parsed);
  }
  return clampDelay(GEMINI_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
};

const fetchGeminiWithRetry = async (url, init, retries = GEMINI_RETRY_COUNT, apiKeyManager = null) => {
  const totalAttempts = retries + 1;
  const requestLabel = describeRequest(url, init);

  // 如果没有传入 apiKeyManager,尝试从 headers 中提取
  if (!apiKeyManager && init?.headers?.["x-goog-api-key"]) {
    apiKeyManager = new ApiKeyManager(init.headers["x-goog-api-key"]);
  }

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    // 更新当前 API Key
    if (apiKeyManager && apiKeyManager.getCurrent()) {
      init.headers = {
        ...init.headers,
        "x-goog-api-key": apiKeyManager.getCurrent()
      };
    }

    try {
      const response = await fetch(url, init);

      // 处理 429 错误 - 切换 API Key
      if (response.status === 429 && apiKeyManager && apiKeyManager.hasMultipleKeys()) {
        const previousKey = apiKeyManager.getCurrent();
        const switched = apiKeyManager.moveToNext();
        const newKey = apiKeyManager.getCurrent();

        if (switched) {
          console.warn(`[Gemini] 429 Rate Limit for ${requestLabel}, switching from API key ${previousKey.substring(0, 8)}... to ${newKey.substring(0, 8)}... and retrying`);
          // 429 时立即重试,不等待
          continue;
        }
      }

      // 处理 503 错误 - 保持当前 API Key
      if (response.status === GEMINI_RETRY_STATUS && attempt < retries) {
        const delay = getRetryDelay(response.headers.get("retry-after"), attempt + 1);
        const currentKey = apiKeyManager && apiKeyManager.getCurrent() ? apiKeyManager.getCurrent().substring(0, 8) + "..." : "default";
        console.warn(`[Gemini] 503 ${response.statusText || ""} for ${requestLabel} (attempt ${attempt + 1}/${totalAttempts}, key: ${currentKey}), retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        let errText = "";
        try {
          errText = await response.clone().text();
        } catch (e) {
          errText = "Failed to read error body";
        }
        console.error(`[Gemini] Request failed ${response.status} ${response.statusText || ""} for ${requestLabel}\nRequest body: ${init.body}\nError body: ${errText}`);
      }
      return response;
    } catch (err) {
      if (attempt === retries) {
        console.error(`[Gemini] Request error for ${requestLabel} after ${totalAttempts} attempts:`, err);
        throw err;
      }
      const delay = getRetryDelay(undefined, attempt + 1);
      console.warn(`[Gemini] Request error for ${requestLabel} (attempt ${attempt + 1}/${totalAttempts}): ${err?.message ?? err}, retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
};

// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "genai-js/0.21.0"; // npm view @google/generative-ai version
const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
  ...more
});

async function handleModels(apiKey) {
  const apiKeyManager = new ApiKeyManager(apiKey);
  const response = await fetchGeminiWithRetry(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKeyManager.getCurrent()),
  }, GEMINI_RETRY_COUNT, apiKeyManager);
  let { body } = response;
  if (response.ok) {
    const { models } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: models.map(({ name }) => ({
        id: name.replace("models/", ""),
        object: "model",
        created: 0,
        owned_by: "",
      })),
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_EMBEDDINGS_MODEL = "gemini-embedding-001";
async function handleEmbeddings(req, apiKey) {
  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  let model;
  if (req.model.startsWith("models/")) {
    model = req.model;
  } else {
    if (!req.model.startsWith("gemini-")) {
      req.model = DEFAULT_EMBEDDINGS_MODEL;
    }
    model = "models/" + req.model;
  }
  if (!Array.isArray(req.input)) {
    req.input = [req.input];
  }
  const apiKeyManager = new ApiKeyManager(apiKey);
  const response = await fetchGeminiWithRetry(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
    method: "POST",
    headers: makeHeaders(apiKeyManager.getCurrent(), { "Content-Type": "application/json" }),
    body: JSON.stringify({
      "requests": req.input.map(text => ({
        model,
        content: { parts: { text } },
        outputDimensionality: req.dimensions,
      }))
    })
  });
  let { body } = response;
  if (response.ok) {
    const { embeddings } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model: req.model,
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_IMAGE_SIZE = "1K";           // 默认生成 2K 分辨率图片
const DEFAULT_ASPECT_RATIO = "3:4";        // 默认 3:4 竖屏（手机拍照默认比例）

// 支持的宽高比例
const VALID_ASPECT_RATIOS = new Set([
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
]);

// 支持的分辨率
const VALID_IMAGE_SIZES = new Set(["1K", "2K", "4K"]);

// OpenAI 尺寸到 Gemini 宽高比的映射
const SIZE_TO_ASPECT_RATIO = {
  "256x256": "1:1",
  "512x512": "1:1",
  "1024x1024": "1:1",
  "1792x1024": "16:9",
  "1024x1792": "9:16"
};
async function handleImages(request, apiKey, pathname) {
  const isEdit = pathname.endsWith("/images/edits");
  let req;

  try {
    // 检查 Content-Type 来决定如何解析请求体
    const contentType = request.headers.get("Content-Type") || "";

    if (contentType.includes("multipart/form-data")) {
      // 处理表单数据（通常用于图片编辑）
      const formData = await request.formData();
      req = {};

      // 提取表单字段
      for (const [key, value] of formData.entries()) {
        if (value instanceof File) {
          // 处理文件上传
          const arrayBuffer = await value.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString('base64');
          const mimeType = value.type || 'image/png';
          req[key] = `data:${mimeType};base64,${base64}`;
        } else {
          req[key] = value;
        }
      }
    } else {
      // 处理 JSON 数据（通常用于图片生成）
      req = await request.json();
    }
  } catch (err) {
    console.error("Error parsing request:", err);
    throw new HttpError("Invalid request format", 400);
  }

  // 验证必需参数
  if (!req.prompt) {
    throw new HttpError("prompt is required", 400);
  }

  // 转换为 Gemini 聊天请求
  const chatRequest = await transformImageRequest(req, isEdit);

  // 调用 Gemini API
  const apiKeyManager = new ApiKeyManager(apiKey);
  const response = await fetchGeminiWithRetry(`${BASE_URL}/${API_VERSION}/models/${DEFAULT_IMAGE_MODEL}:generateContent`, {
    method: "POST",
    headers: makeHeaders(apiKeyManager.getCurrent(), { "Content-Type": "application/json" }),
    body: JSON.stringify(chatRequest),
  }, GEMINI_RETRY_COUNT, apiKeyManager);

  let { body } = response;
  if (response.ok) {
    body = await response.text();
    try {
      const geminiResponse = JSON.parse(body);
      if (!geminiResponse.candidates) {
        throw new Error("Invalid completion object");
      }
      // 处理响应并提取图片
      body = await processImageResponse(geminiResponse, req);
    } catch (err) {
      console.error("Error parsing image response:", err);
      return new Response(body, fixCors(response));
    }
  }

  return new Response(body, fixCors(response));
}

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TRANSCRIPTION_MODEL = DEFAULT_MODEL;
const ASR_SUPPORTED_RESPONSE_FORMATS = new Set(["json", "text"]);
const ASR_DEFAULT_RESPONSE_FORMAT = "json";
const ASR_TASK_PROMPTS = {
  transcribe: "Generate a verbatim transcript of the provided audio.",
  translate: "Translate the provided audio into natural English text."
};

async function handleCompletions(req, apiKey) {
  console.log("[OpenAI] Incoming request body:", JSON.stringify(req, null, 2));
  let model = DEFAULT_MODEL;
  switch (true) {
    case typeof req.model !== "string":
      break;
    case req.model.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model.startsWith("gemini-"):
    case req.model.startsWith("gemma-"):
    case req.model.startsWith("learnlm-"):
      model = req.model;
  }
  let body = await transformRequest(req);
  const extra = req.extra_body?.google
  if (extra) {
    if (extra.safety_settings) {
      body.safetySettings = extra.safety_settings;
    }
    if (extra.cached_content) {
      body.cachedContent = extra.cached_content;
    }
    if (extra.thinking_config) {
      body.generationConfig.thinkingConfig = extra.thinking_config;
    }
  }
  switch (true) {
    case model.endsWith(":search"):
      model = model.substring(0, model.length - 7);
    // eslint-disable-next-line no-fallthrough
    case req.model.endsWith("-search-preview"):
      body.tools = body.tools || [];
      body.tools.push({ googleSearch: {} }, { urlContext: {} });
  }
  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }
  const apiKeyManager = new ApiKeyManager(apiKey);
  const response = await fetchGeminiWithRetry(url, {
    method: "POST",
    headers: makeHeaders(apiKeyManager.getCurrent(), { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  }, GEMINI_RETRY_COUNT, apiKeyManager);

  body = response.body;
  if (response.ok) {
    let id = "chatcmpl-" + generateId(); //"chatcmpl-8pMMaqXMK68B3nyDBrapTDrhkHBQK";
    const shared = {};
    if (req.stream) {
      body = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
          shared,
        }))
        .pipeThrough(new TransformStream({
          transform: toOpenAiStream,
          flush: toOpenAiStreamFlush,
          streamIncludeUsage: req.stream_options?.include_usage,
          model, id, last: [],
          shared,
        }))
        .pipeThrough(new TextEncoderStream());
    } else {
      body = await response.text();
      try {
        body = JSON.parse(body);
        if (!body.candidates) {
          console.error("Gemini response without candidates:", JSON.stringify(body, null, 2));
          throw new Error("Invalid completion object");
        }
      } catch (err) {
        console.error("Error parsing response:", err);
        return new Response(body, fixCors(response)); // output as is
      }
      body = await processCompletionsResponse(body, model, id);
    }
  }
  return new Response(body, fixCors(response));
}

async function handleAudioTranscription(request, apiKey, { task = "transcribe" } = {}) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    throw new HttpError("Content-Type must be multipart/form-data", 400);
  }
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new HttpError("file is required", 400);
  }

  const responseFormat = (getFormValue(formData, "response_format") || ASR_DEFAULT_RESPONSE_FORMAT).toLowerCase();
  if (!ASR_SUPPORTED_RESPONSE_FORMATS.has(responseFormat)) {
    throw new HttpError(`Unsupported response_format: ${responseFormat}`, 400);
  }

  const requestedModel = getFormValue(formData, "model");
  const model = resolveGeminiModel(requestedModel, DEFAULT_TRANSCRIPTION_MODEL);
  const prompt = buildAsrPrompt(task, getFormValue(formData, "language"), getFormValue(formData, "prompt"));
  const temperature = parseFloat(getFormValue(formData, "temperature"));

  const arrayBuffer = await file.arrayBuffer();
  if (!arrayBuffer || !arrayBuffer.byteLength) {
    throw new HttpError("file is empty", 400);
  }
  const audioBase64 = Buffer.from(arrayBuffer).toString("base64");
  const mimeType = getAudioMimeType(file);

  const body = {
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data: audioBase64 } },
      ]
    }],
    safetySettings,
  };
  if (!Number.isNaN(temperature)) {
    body.generationConfig = { temperature };
  }

  const apiKeyManager = new ApiKeyManager(apiKey);
  const response = await fetchGeminiWithRetry(`${BASE_URL}/${API_VERSION}/models/${model}:generateContent`, {
    method: "POST",
    headers: makeHeaders(apiKeyManager.getCurrent(), { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  }, GEMINI_RETRY_COUNT, apiKeyManager);

  let { body: responseBody } = response;
  if (!response.ok) {
    return new Response(responseBody, fixCors(response));
  }

  let geminiPayload;
  try {
    geminiPayload = JSON.parse(await response.text());
  } catch (err) {
    console.error("Error parsing transcription response:", err);
    throw new HttpError("Invalid transcription response", 502);
  }
  const transcript = extractTranscriptionText(geminiPayload);
  const { payload, contentType: resultContentType } = formatAsrResponse(transcript, responseFormat);

  const init = fixCors(response);
  init.headers.set("Content-Type", resultContentType);
  return new Response(payload, init);
}

const getFormValue = (formData, key) => {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : undefined;
};

const resolveGeminiModel = (model, fallback) => {
  if (typeof model !== "string") {
    return fallback;
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed.startsWith("models/")) {
    return trimmed.substring(7);
  }
  if (trimmed.startsWith("gemini-") || trimmed.startsWith("gemma-") || trimmed.startsWith("learnlm-")) {
    return trimmed;
  }
  return fallback;
};

const buildAsrPrompt = (task, language, userPrompt) => {
  let base = ASR_TASK_PROMPTS[task] || ASR_TASK_PROMPTS.transcribe;
  if (language) {
    base += ` The audio language is ${language}.`;
  }
  if (userPrompt) {
    base += ` ${userPrompt}`;
  }
  return base;
};

const getAudioMimeType = (file) => {
  const normalizedType = file?.type?.toLowerCase();
  if (normalizedType && normalizedType !== "application/octet-stream") {
    return normalizedType;
  }
  const name = file?.name || "";
  const ext = name.includes(".") ? name.substring(name.lastIndexOf(".") + 1).toLowerCase() : "";
  switch (ext) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "aac":
      return "audio/aac";
    case "ogg":
    case "oga":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "aiff":
    case "aif":
      return "audio/aiff";
    default:
      return "audio/mpeg";
  }
};

const extractTranscriptionText = (payload) => {
  const candidates = payload?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new HttpError("Transcription not available", 502);
  }
  for (const candidate of candidates) {
    const text = (candidate.content?.parts || [])
      .map(part => part?.text || "")
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }
  throw new HttpError("Gemini did not return transcription text", 502);
};

const formatAsrResponse = (text, format) => {
  if (format === "text") {
    return { payload: text, contentType: "text/plain; charset=utf-8" };
  }
  return {
    payload: JSON.stringify({ text }, null, 2),
    contentType: "application/json"
  };
};

const adjustProps = (schemaPart) => {
  if (typeof schemaPart !== "object" || schemaPart === null) {
    return;
  }
  if (Array.isArray(schemaPart)) {
    schemaPart.forEach(adjustProps);
  } else {
    if (schemaPart.type === "object" && schemaPart.properties && schemaPart.additionalProperties === false) {
      delete schemaPart.additionalProperties;
    }
    Object.values(schemaPart).forEach(adjustProps);
  }
};
const adjustSchema = (schema) => {
  const obj = schema[schema.type];
  delete obj.strict;
  return adjustProps(schema);
};

const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map(category => ({
  category,
  threshold: "BLOCK_NONE",
}));
const fieldsMap = {
  frequency_penalty: "frequencyPenalty",
  max_completion_tokens: "maxOutputTokens",
  max_tokens: "maxOutputTokens",
  n: "candidateCount", // not for streaming
  presence_penalty: "presencePenalty",
  seed: "seed",
  stop: "stopSequences",
  temperature: "temperature",
  top_k: "topK", // non-standard
  top_p: "topP",
};
const thinkingBudgetMap = {
  low: 1024,
  medium: 8192,
  high: 24576,
};
const transformConfig = (req) => {
  let cfg = {};
  //if (typeof req.stop === "string") { req.stop = [req.stop]; } // no need
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format) {
    switch (req.response_format.type) {
      case "json_schema":
        adjustSchema(req.response_format);
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
      // eslint-disable-next-line no-fallthrough
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }

  // 默认启用思考总结,确保思考内容被正确标记
  // 对于不支持思考的老模型,这个配置会被忽略
  cfg.thinkingConfig = cfg.thinkingConfig || {};
  cfg.thinkingConfig.includeThoughts = true;

  if (req.reasoning_effort) {
    cfg.thinkingConfig.thinkingBudget = thinkingBudgetMap[req.reasoning_effort];
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type");
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) {
      throw new HttpError("Invalid image data: " + url, 400);
    }
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformFnResponse = ({ content, tool_call_id }, parts) => {
  if (!parts.calls) {
    throw new HttpError("No function calls found in the previous message", 400);
  }
  let response;
  try {
    response = JSON.parse(content);
  } catch (err) {
    console.error("Error parsing function response content:", err);
    // throw new HttpError("Invalid function response: " + content, 400);
    console.log(content);
    response = content;
  }
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    response = { result: response };
  }
  if (!tool_call_id) {
    throw new HttpError("tool_call_id not specified", 400);
  }
  const { i, name } = parts.calls[tool_call_id] ?? {};
  if (!name) {
    throw new HttpError("Unknown tool_call_id: " + tool_call_id, 400);
  }
  if (parts[i]) {
    throw new HttpError("Duplicated tool_call_id: " + tool_call_id, 400);
  }
  parts[i] = {
    functionResponse: {
      id: tool_call_id.startsWith("call_") ? null : tool_call_id,
      name,
      response,
    }
  };
};

const getThoughtSignature = (source = {}) =>
  source.extra_content?.google?.thought_signature
  ?? source.extra_content?.google?.thoughtSignature
  ?? source.extraContent?.google?.thought_signature
  ?? source.extraContent?.google?.thoughtSignature
  ?? source.thought_signature
  ?? source.thoughtSignature;

const transformFnCalls = ({ tool_calls }) => {
  const calls = {};
  const parts = tool_calls.map((toolCall, i) => {
    const { function: { arguments: argstr, name }, id, type } = toolCall;
    if (type !== "function") {
      throw new HttpError(`Unsupported tool_call type: "${type}"`, 400);
    }
    let args;
    try {
      args = JSON.parse(argstr);
    } catch (err) {
      console.error("Error parsing function arguments:", err);
      throw new HttpError("Invalid function arguments: " + argstr, 400);
    }
    calls[id] = { i, name };
    const part = {
      functionCall: {
        id: id.startsWith("call_") ? null : id,
        name,
        args,
      }
    };
    const thoughtSignature = getThoughtSignature(toolCall);
    if (thoughtSignature) {
      part.thoughtSignature = thoughtSignature;
    }
    return part;
  });
  parts.calls = calls;
  return parts;
};

const transformMsg = async ({ content }) => {
  const parts = [];
  if (!Array.isArray(content)) {
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    parts.push({ text: content?.toString() ?? " " });
    return parts;
  }
  // user:
  // An array of content parts with a defined type.
  // Supported options differ based on the model being used to generate the response.
  // Can contain text, image, or audio inputs.
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({ text: item.text });
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          }
        });
        break;
      default:
        throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({ text: "" }); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return parts;
};

const transformMessages = async (messages) => {
  if (!messages) { return; }
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    switch (item.role) {
      case "system":
        system_instruction = { parts: await transformMsg(item) };
        continue;
      case "tool":
        // eslint-disable-next-line no-case-declarations
        let { role, parts } = contents[contents.length - 1] ?? {};
        if (role !== "function") {
          const calls = parts?.calls;
          parts = []; parts.calls = calls;
          contents.push({
            role: "function", // ignored
            parts
          });
        }
        transformFnResponse(item, parts);
        continue;
      case "assistant":
        item.role = "model";
        break;
      case "user":
        break;
      default:
        throw new HttpError(`Unknown message role: "${item.role}"`, 400);
    }
    contents.push({
      role: item.role,
      parts: item.tool_calls ? transformFnCalls(item) : await transformMsg(item)
    });
  }
  if (system_instruction) {
    if (!contents[0]?.parts.some(part => part.text)) {
      contents.unshift({ role: "user", parts: { text: " " } });
    }
  }
  //console.info(JSON.stringify(contents, 2));
  return { system_instruction, contents };
};

const transformTools = (req) => {
  let tools, tool_config;
  if (req.tools) {
    const funcs = req.tools.filter(tool => tool.type === "function");
    funcs.forEach(adjustSchema);
    tools = [{ function_declarations: funcs.map(schema => schema.function) }];
  }
  if (req.tool_choice) {
    const allowed_function_names = req.tool_choice?.type === "function" ? [req.tool_choice?.function?.name] : undefined;
    if (allowed_function_names || typeof req.tool_choice === "string") {
      tool_config = {
        function_calling_config: {
          mode: allowed_function_names ? "ANY" : req.tool_choice.toUpperCase(),
          allowed_function_names
        }
      };
    }
  }
  return { tools, tool_config };
};

const transformImageRequest = async (req, isEdit) => {
  let prompt = req.prompt;
  const parts = [];

  if (isEdit) {
    // 图片编辑请求
    if (!req.image) {
      throw new HttpError("image is required for editing", 400);
    }

    // 添加原图片
    parts.push(await parseImg(req.image));

    // 如果有 mask，也添加 mask
    if (req.mask) {
      parts.push(await parseImg(req.mask));
      prompt = `Edit the image based on this mask and the following instructions: ${prompt}. Please generate the edited image.`;
    } else {
      prompt = `Edit this image according to the following instructions: ${prompt}. Please generate the edited image.`;
    }
  } else {
    // 图片生成请求
    prompt = `Generate an image based on the following description: ${prompt}`;
  }

  // 处理风格和质量要求
  if (req.style) {
    prompt += ` Style: ${req.style}.`;
  }

  if (req.quality) {
    prompt += ` Quality: ${req.quality}.`;
  }

  // 添加文本提示
  parts.push({ text: prompt });

  const contents = [{
    role: "user",
    parts
  }];

  // 解析宽高比: 优先使用 aspect_ratio，其次从 size 转换
  // 编辑模式下默认不设置（匹配原图），生成模式下使用默认值
  let aspectRatio = null;
  if (req.aspect_ratio && VALID_ASPECT_RATIOS.has(req.aspect_ratio)) {
    aspectRatio = req.aspect_ratio;
  } else if (req.size && SIZE_TO_ASPECT_RATIO[req.size]) {
    aspectRatio = SIZE_TO_ASPECT_RATIO[req.size];
  } else if (!isEdit) {
    // 仅在生成模式下使用默认宽高比
    aspectRatio = DEFAULT_ASPECT_RATIO;
  }

  // 解析分辨率: 优先使用 image_size，默认 2K
  let imageSize = DEFAULT_IMAGE_SIZE;
  if (req.image_size) {
    const normalized = req.image_size.toUpperCase();
    if (VALID_IMAGE_SIZES.has(normalized)) {
      imageSize = normalized;
    }
  }

  // 设置生成配置
  const generationConfig = {
    responseModalities: ["IMAGE"],  // 仅返回图片
    imageConfig: {
      imageSize
    }
  };

  // 仅在指定了宽高比时才添加（编辑模式下可能为 null 以匹配原图）
  if (aspectRatio) {
    generationConfig.imageConfig.aspectRatio = aspectRatio;
  }

  if (req.n && req.n > 1) {
    generationConfig.candidateCount = Math.min(req.n, 4); // Gemini 最多支持 4 个候选
  }

  return {
    contents,
    safetySettings,
    generationConfig
  };
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
  ...transformTools(req),
});

const generateId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  //"FINISH_REASON_UNSPECIFIED": // Default value. This value is unused.
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  //"OTHER": "OTHER",
};
async function uploadImageToHost(base64Data, authToken) {
  try {
    // 将 base64 转换为 Uint8Array
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // 创建 Blob
    const blob = new Blob([bytes], { type: 'image/png' });

    // 创建 FormData
    const formData = new FormData();
    formData.append('image', blob, 'image.png');

    // 发送请求到图床
    const response = await fetch('https://i.111666.best/image', {
      method: 'POST',
      body: formData,
      headers: {
        'Auth-Token': authToken
      }
    });

    if (!response.ok) {
      throw new Error(`图床上传失败: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    // console.log(result);
    // 检查上传是否成功
    if (result.ok && result.src) {
      // 拼接完整的 URL
      const fullImageUrl = `https://i.111666.best${result.src}`;
      return fullImageUrl;
    } else {
      throw new Error('图床返回失败状态');
    }
  } catch (error) {
    console.error('上传图片到图床失败:', error);
    return null;
  }
}
const SEP = "\n\n|>";
const transformCandidates = async (key, cand) => {
  const message = { role: "assistant", content: [] };
  let answer = "";
  let reasoning_content = "";

  for (const part of cand.content?.parts ?? []) {
    if (part.functionCall) {
      const fc = part.functionCall;
      const thoughtSignature = part.thoughtSignature ?? part.thought_signature;
      message.tool_calls = message.tool_calls ?? [];
      message.tool_calls.push({
        id: fc.id ?? "call_" + generateId(),
        type: "function",
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args),
        },
        ...(thoughtSignature && {
          extra_content: {
            google: {
              thought_signature: thoughtSignature
            }
          }
        })
      });
    } else if (part.thought) {
      reasoning_content += part.text;
    } else if (part.inlineData) {
      // 等待图片上传完成
      const imageUrl = await uploadImageToHost(part.inlineData.data, '123456');
      // console.log(imageUrl);
      if (imageUrl) {
        answer += `\n![图片](${imageUrl})`;
      } else {
        answer += '\n[图片上传失败]';
      }
    } else {
      answer += part.text;
    }
  }

  message.content = answer;
  if (reasoning_content != "") {
    message.reasoning_content = reasoning_content;
  }
  return {
    index: cand.index || 0,
    [key]: message,
    logprobs: null,
    finish_reason: message.tool_calls ? "tool_calls" : reasonsMap[cand.finishReason] || cand.finishReason,
  };
};
const transformCandidatesMessage = (cand) => transformCandidates("message", cand);
const transformCandidatesDelta = (cand) => transformCandidates("delta", cand);

const transformUsage = (data) => ({
  completion_tokens: data.candidatesTokenCount,
  prompt_tokens: data.promptTokenCount,
  total_tokens: data.totalTokenCount
});

const checkPromptBlock = (choices, promptFeedback, key) => {
  if (choices.length) { return; }
  if (promptFeedback?.blockReason) {
    console.log("Prompt block reason:", promptFeedback.blockReason);
    if (promptFeedback.blockReason === "SAFETY") {
      promptFeedback.safetyRatings
        .filter(r => r.blocked)
        .forEach(r => console.log(r));
    }
    choices.push({
      index: 0,
      [key]: null,
      finish_reason: "content_filter",
      //original_finish_reason: data.promptFeedback.blockReason,
    });
  }
  return true;
};

const processImageResponse = async (data, originalReq) => {
  const images = [];

  // 处理所有候选响应
  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
        // 上传图片到图床
        const imageUrl = await uploadImageToHost(part.inlineData.data, '123456');
        if (imageUrl) {
          const imageData = {
            url: imageUrl
          };

          // 如果请求要求返回 base64 格式
          if (originalReq.response_format === 'b64_json') {
            imageData.b64_json = part.inlineData.data;
            delete imageData.url;
          }

          // 添加修订提示（如果是编辑请求）
          if (originalReq.prompt) {
            imageData.revised_prompt = originalReq.prompt;
          }

          images.push(imageData);
        }
      }
    }
  }

  // 如果没有找到图片，返回错误
  if (images.length === 0) {
    console.warn("No images found in Gemini response");
    throw new HttpError("Failed to generate image", 500);
  }

  // 构造 OpenAI 格式的响应
  const response = {
    created: Math.floor(Date.now() / 1000),
    data: images
  };

  return JSON.stringify(response, null, 2);
};

const processCompletionsResponse = async (data, model, id) => {
  const obj = {
    id,
    choices: await Promise.all(data.candidates.map(transformCandidatesMessage)),
    created: Math.floor(Date.now() / 1000),
    model: data.modelVersion ?? model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion",
    usage: data.usageMetadata && transformUsage(data.usageMetadata),
  };
  if (obj.choices.length === 0) {
    checkPromptBlock(obj.choices, data.promptFeedback, "message");
  }
  return JSON.stringify(obj);
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
function parseStream(chunk, controller) {
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}
function parseStreamFlush(controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
    this.shared.is_buffers_rest = true;
  }
}

const delimiter = "\n\n";
const sseline = (obj) => {
  obj.created = Math.floor(Date.now() / 1000);
  return "data: " + JSON.stringify(obj) + delimiter;
};
async function toOpenAiStream(line, controller) {
  let data;
  try {
    data = JSON.parse(line);
    if (!data.candidates) {
      throw new Error("Invalid completion chunk object");
    }
  } catch (err) {
    console.error("Error parsing response:", err);
    if (!this.shared.is_buffers_rest) { line = + delimiter; }
    controller.enqueue(line); // output as is
    return;
  }
  const obj = {
    id: this.id,
    choices: await Promise.all(data.candidates.map(transformCandidatesDelta)),
    //created: Math.floor(Date.now()/1000),
    model: data.modelVersion ?? this.model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion.chunk",
    usage: data.usageMetadata && this.streamIncludeUsage ? null : undefined,
  };
  if (checkPromptBlock(obj.choices, data.promptFeedback, "delta")) {
    controller.enqueue(sseline(obj));
    return;
  }
  console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
  const cand = obj.choices[0];
  cand.index = cand.index || 0; // absent in new -002 models response
  const finish_reason = cand.finish_reason;
  cand.finish_reason = null;
  if (!this.last[cand.index]) { // first
    controller.enqueue(sseline({
      ...obj,
      choices: [{ ...cand, tool_calls: undefined, delta: { role: "assistant", content: "" } }],
    }));
  }
  delete cand.delta.role;
  if ("content" in cand.delta) { // prevent empty data (e.g. when MAX_TOKENS)
    controller.enqueue(sseline(obj));
  }
  cand.finish_reason = finish_reason;
  if (data.usageMetadata && this.streamIncludeUsage) {
    obj.usage = transformUsage(data.usageMetadata);
  }
  cand.delta = {};
  this.last[cand.index] = obj;
}
function toOpenAiStreamFlush(controller) {
  if (this.last.length > 0) {
    for (const obj of this.last) {
      controller.enqueue(sseline(obj));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}
