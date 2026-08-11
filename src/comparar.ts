import OpenAI from "openai";

const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const OLLAMA_MODEL = "qwen3:4b";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";

type OllamaResponse = {
  message?: {
    content?: string;
  };
};

type TimedResult = {
  text: string;
  elapsedMs: number;
};

async function measure(action: () => Promise<string>): Promise<TimedResult> {
  const startedAt = performance.now();
  const text = await action();

  return {
    text,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

async function askOllama(prompt: string): Promise<string> {
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        {
          role: "system",
          content: "Responde em português europeu, de forma clara e concisa.",
        },
        { role: "user", content: `/no_think\n${prompt}` },
      ],
      stream: false,
      think: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`Ollama respondeu com HTTP ${response.status}`);
  }

  const data = (await response.json()) as OllamaResponse;
  const answer = data.message?.content
    ?.replace(/^[\s\S]*<\/think>\s*/i, "")
    .trim();

  if (!answer) {
    throw new Error("O Ollama devolveu uma resposta vazia.");
  }

  return answer;
}

async function askOpenAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY não foi encontrada no ambiente.");
  }

  const openai = new OpenAI({ apiKey });
  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    instructions: "Responde em português europeu, de forma clara e concisa.",
    input: prompt,
  });

  const answer = response.output_text.trim();

  if (!answer) {
    throw new Error("A OpenAI devolveu uma resposta vazia.");
  }

  return answer;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Erro desconhecido";
}

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();

  if (!prompt) {
    console.error(
      'Uso: node --env-file=.env.test dist\\comparar.js "A tua pergunta"',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nPERGUNTA\n${prompt}\n`);

  const [ollamaResult, openAIResult] = await Promise.allSettled([
    measure(() => askOllama(prompt)),
    measure(() => askOpenAI(prompt)),
  ]);

  if (ollamaResult.status === "fulfilled") {
    console.log(
      `OLLAMA — ${OLLAMA_MODEL} (${ollamaResult.value.elapsedMs} ms)\n${ollamaResult.value.text}\n`,
    );
  } else {
    console.error(`OLLAMA — ERRO\n${errorMessage(ollamaResult.reason)}\n`);
    process.exitCode = 1;
  }

  if (openAIResult.status === "fulfilled") {
    console.log(
      `OPENAI — ${OPENAI_MODEL} (${openAIResult.value.elapsedMs} ms)\n${openAIResult.value.text}\n`,
    );
  } else {
    console.error(`OPENAI — ERRO\n${errorMessage(openAIResult.reason)}\n`);
    process.exitCode = 1;
  }
}

await main();