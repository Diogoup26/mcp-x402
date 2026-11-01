export const MCP_TOOL_DESCRIPTIONS = {
  consultar_ia:
    "Use for general questions that do not require live web retrieval. Returns a concise model answer and does not fetch URLs or verify current facts. Use analisar_url for a source-bounded page report and verificar_condicoes for evidence-backed decisions. PT: Use para perguntas gerais sem pesquisa web em tempo real.",
  analisar_url:
    "Use to fetch one public HTTP or HTTPS page and return a source-bounded report with summary, facts, risks and recommended actions. The optional objective controls focus but is never evidence. It does not consult other sources; use verificar_condicoes for condition-by-condition decisions. PT: Analisa uma página pública sem usar fontes externas.",
  verificar_condicoes:
    "Use before an agent trusts, buys or acts to test 1 to 10 explicit conditions against one public HTTP or HTTPS page. Returns confirmed, rejected or uncertain for every condition with textual evidence when available, plus source, verifiedAt, verificationId and pageHash. Missing evidence produces uncertain, not a false confirmation. PT: Verifica condições com prova auditável.",
} as const;

export const BAZAAR_TOOL_DESCRIPTIONS = {
  consultar_ia:
    "Use for general questions that do not require live web retrieval. Returns a concise model answer; it does not fetch URLs or verify current facts. Use analisar_url for page reports and verificar_condicoes for evidence-backed checks.",
  analisar_url:
    "Use to fetch one public HTTP or HTTPS page and return a source-bounded report with summary, extracted facts, risks and recommended actions. The optional objective controls focus. It does not consult external sources; use verificar_condicoes for per-condition evidence.",
  verificar_condicoes:
    "Use to test 1 to 10 explicit conditions against one public HTTP or HTTPS page. Returns confirmed, rejected or uncertain for each condition with quoted evidence, plus source, verification time, verification ID and page hash. Missing evidence produces uncertain.",
} as const;

export const MCP_ARGUMENT_DESCRIPTIONS = {
  prompt:
    "Pergunta ou instrução, entre 1 e 4000 caracteres. Não pressupõe pesquisa web em tempo real.",
  analysisUrl:
    "URL HTTP ou HTTPS pública a extrair. Endereços locais, privados e não públicos são rejeitados.",
  analysisObjective:
    "Foco opcional do relatório, até 500 caracteres; orienta a análise mas não é tratado como prova.",
  verificationUrl:
    "URL HTTP ou HTTPS pública onde as condições serão verificadas. Endereços locais, privados e não públicos são rejeitados.",
  conditions:
    "Lista de 1 a 10 condições concretas e verificáveis; cada condição deve ter entre 3 e 300 caracteres.",
  verificationContext:
    "Contexto opcional, até 500 caracteres, usado apenas para interpretar as condições e nunca como prova da página.",
} as const;

export const BAZAAR_ARGUMENT_DESCRIPTIONS = {
  prompt:
    "Question or instruction, 1 to 4000 characters. This tool does not perform live web retrieval.",
  analysisUrl:
    "Public HTTP or HTTPS URL to fetch. Local, private and otherwise non-public addresses are rejected.",
  analysisObjective:
    "Optional report focus, up to 500 characters; guides the analysis but is not treated as page evidence.",
  verificationUrl:
    "Public HTTP or HTTPS URL on which to verify the conditions. Local, private and otherwise non-public addresses are rejected.",
  conditions:
    "List of 1 to 10 concrete, testable conditions; each condition must contain 3 to 300 characters.",
  verificationContext:
    "Optional context, up to 500 characters, used only to interpret conditions and never as page evidence.",
} as const;

export const BAZAAR_TOOL_EXAMPLES = {
  consultar_ia: {
    input: {
      prompt:
        "Explain the difference between absence of evidence and contradictory evidence.",
    },
    output: {
      answer:
        "Absence of evidence means the available source does not establish the claim; contradictory evidence means the source supports the opposite conclusion.",
    },
  },
  analisar_url: {
    input: {
      url: "https://example.com",
      objetivo: "Identify the page purpose and any decision-relevant limitations.",
    },
    output: {
      source: "https://example.com/",
      title: "Example Domain",
      report:
        "1. Summary: The page is a reserved example domain. 2. Facts: It is intended for documentation examples. 3. Risks or limitations: It does not describe a real seller or offer. 4. Recommended actions: Do not use it as commercial evidence.",
    },
  },
  verificar_condicoes: {
    input: {
      url: "https://shop.example/offers/refurbished-laptop",
      condicoes: [
        "The offer includes a 12-month warranty.",
        "The return period is at least 30 days.",
        "The seller is an authorized manufacturer reseller.",
      ],
      contexto: "Pre-purchase seller verification.",
    },
    output: {
      source: "https://shop.example/offers/refurbished-laptop",
      title: "Refurbished Laptop Offer — Example Seller",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      decisao: {
        decisao: "incerto",
        condicoes: [
          {
            condicao: "The offer includes a 12-month warranty.",
            estado: "confirmada",
            prova: "Includes a 12-month limited warranty.",
            explicacao:
              "The offer explicitly states the warranty duration.",
          },
          {
            condicao: "The return period is at least 30 days.",
            estado: "rejeitada",
            prova: "Returns accepted within 14 days of delivery.",
            explicacao:
              "The stated 14-day return period contradicts the required minimum of 30 days.",
          },
          {
            condicao: "The seller is an authorized manufacturer reseller.",
            estado: "incerta",
            prova: null,
            explicacao:
              "The page provides no evidence of manufacturer authorization.",
          },
        ],
        resumo:
          "The warranty is confirmed, the return-period requirement is rejected, and reseller authorization remains uncertain.",
      },
      verificationId: "00000000-0000-4000-8000-000000000000",
      pageHash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
  },
} as const;

const conditionResultJsonSchema = {
  type: "object",
  properties: {
    condicao: { type: "string" },
    estado: {
      type: "string",
      enum: ["confirmada", "rejeitada", "incerta"],
    },
    prova: { type: ["string", "null"] },
    explicacao: { type: "string" },
  },
  required: ["condicao", "estado", "prova", "explicacao"],
  additionalProperties: false,
} as const;

export const BAZAAR_OUTPUT_SCHEMAS = {
  consultar_ia: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "Concise model answer without live web retrieval.",
      },
    },
    required: ["answer"],
    additionalProperties: false,
  },
  analisar_url: {
    type: "object",
    properties: {
      source: { type: "string", format: "uri" },
      title: { type: "string" },
      report: {
        type: "string",
        description:
          "Source-bounded report containing summary, facts, risks or limitations and recommended actions.",
      },
    },
    required: ["source", "title", "report"],
    additionalProperties: false,
  },
  verificar_condicoes: {
    type: "object",
    properties: {
      source: { type: "string", format: "uri" },
      title: { type: "string" },
      verifiedAt: { type: "string", format: "date-time" },
      decisao: {
        type: "object",
        properties: {
          decisao: {
            type: "string",
            enum: ["confirmado", "rejeitado", "incerto"],
          },
          condicoes: {
            type: "array",
            items: conditionResultJsonSchema,
          },
          resumo: { type: "string" },
        },
        required: ["decisao", "condicoes", "resumo"],
        additionalProperties: false,
      },
      verificationId: { type: "string", format: "uuid" },
      pageHash: {
        type: "string",
        pattern: "^sha256:[a-f0-9]{64}$",
      },
    },
    required: [
      "source",
      "title",
      "verifiedAt",
      "decisao",
      "verificationId",
      "pageHash",
    ],
    additionalProperties: false,
  },
} as const;
