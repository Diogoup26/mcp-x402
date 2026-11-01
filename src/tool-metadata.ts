export const MCP_TOOL_DESCRIPTIONS = {
  preview_verification:
    "Use this free static preview before paying for verificar_condicoes. Choose offer_terms to inspect warranty, returns and availability; seller_trust to inspect seller identity and authorization; or policy_compliance to inspect required policy terms. It performs no web request, OpenAI call or payment and returns a realistic structured example plus the exact paid next step. PT: Pré-visualização gratuita e estática da verificação.",
  consultar_ia:
    "Use for general questions that do not require live web retrieval. Returns a concise model answer and does not fetch URLs or verify current facts. Use analisar_url for a source-bounded page report and verificar_condicoes for evidence-backed decisions. PT: Use para perguntas gerais sem pesquisa web em tempo real.",
  analisar_url:
    "Use to fetch one public HTTP or HTTPS page and return a source-bounded report with summary, facts, risks and recommended actions. The optional objective controls focus but is never evidence. It does not consult other sources; use verificar_condicoes for condition-by-condition decisions. PT: Analisa uma página pública sem usar fontes externas.",
  verificar_condicoes:
    "Use before an agent trusts, buys or acts to test 1 to 10 explicit conditions against one public HTTP or HTTPS page. Best fits offer and warranty checks, seller identity or authorization checks, and policy compliance checks. Returns confirmed, rejected or uncertain for every condition with textual evidence when available, plus source, verifiedAt, verificationId and pageHash. Missing evidence produces uncertain, not a false confirmation. Use preview_verification first when the buyer needs a free example. PT: Verifica condições com prova auditável.",
} as const;

export const BAZAAR_TOOL_DESCRIPTIONS = {
  consultar_ia:
    "Use for general questions that do not require live web retrieval. Returns a concise model answer; it does not fetch URLs or verify current facts. Use analisar_url for page reports and verificar_condicoes for evidence-backed checks.",
  analisar_url:
    "Use to fetch one public HTTP or HTTPS page and return a source-bounded report with summary, extracted facts, risks and recommended actions. The optional objective controls focus. It does not consult external sources; use verificar_condicoes for per-condition evidence.",
  verificar_condicoes:
    "Use to test 1 to 10 explicit conditions against one public HTTP or HTTPS page before an agent buys, trusts or acts. Optimized for offer and warranty checks, seller identity or authorization checks, and policy compliance checks. Returns confirmed, rejected or uncertain for each condition with quoted evidence, plus source, verification time, verification ID and page hash. Missing evidence produces uncertain.",
} as const;

export const VERIFICATION_USE_CASES = [
  "offer_terms",
  "seller_trust",
  "policy_compliance",
] as const;

export const VERIFICATION_PREVIEW_CASES = {
  offer_terms: {
    label: "Offer, warranty and returns check",
    input: {
      url: "https://shop.example/offers/refurbished-laptop",
      condicoes: [
        "The offer includes a 12-month warranty.",
        "The return period is at least 30 days.",
        "The product is available for delivery to Portugal.",
      ],
      contexto: "Pre-purchase offer verification.",
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
            explicacao: "The offer explicitly states the warranty duration.",
          },
          {
            condicao: "The return period is at least 30 days.",
            estado: "rejeitada",
            prova: "Returns accepted within 14 days of delivery.",
            explicacao:
              "The stated 14-day return period contradicts the required minimum.",
          },
          {
            condicao: "The product is available for delivery to Portugal.",
            estado: "incerta",
            prova: null,
            explicacao:
              "The page does not identify the supported delivery countries.",
          },
        ],
        resumo:
          "The warranty is confirmed, the return requirement is rejected and delivery remains uncertain.",
      },
      verificationId: "00000000-0000-4000-8000-000000000000",
      pageHash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
  },
  seller_trust: {
    label: "Seller identity and authorization check",
    input: {
      url: "https://seller.example/about",
      condicoes: [
        "The page identifies the legal seller.",
        "The seller claims to be an authorized manufacturer reseller.",
        "The page provides a verifiable company registration number.",
      ],
      contexto: "Seller trust verification before purchase.",
    },
    output: {
      source: "https://seller.example/about",
      title: "About Example Seller",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      decisao: {
        decisao: "incerto",
        condicoes: [
          {
            condicao: "The page identifies the legal seller.",
            estado: "confirmada",
            prova: "Example Seller Europe, Lda.",
            explicacao: "The page explicitly names the legal seller.",
          },
          {
            condicao: "The seller claims to be an authorized manufacturer reseller.",
            estado: "rejeitada",
            prova: "We are an independent reseller and are not manufacturer-authorized.",
            explicacao: "The page explicitly contradicts manufacturer authorization.",
          },
          {
            condicao: "The page provides a verifiable company registration number.",
            estado: "incerta",
            prova: null,
            explicacao: "No company registration number appears on the page.",
          },
        ],
        resumo:
          "The seller is named, manufacturer authorization is rejected and registration remains uncertain.",
      },
      verificationId: "11111111-1111-4111-8111-111111111111",
      pageHash:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    },
  },
  policy_compliance: {
    label: "Policy and terms compliance check",
    input: {
      url: "https://service.example/terms",
      condicoes: [
        "The policy states how personal data is deleted.",
        "The subscription can be cancelled without a penalty.",
        "The policy identifies a response time for support requests.",
      ],
      contexto: "Policy compliance check before an agent subscribes.",
    },
    output: {
      source: "https://service.example/terms",
      title: "Example Service Terms",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      decisao: {
        decisao: "incerto",
        condicoes: [
          {
            condicao: "The policy states how personal data is deleted.",
            estado: "confirmada",
            prova: "Account data is deleted within 30 days of a verified request.",
            explicacao: "The policy describes a concrete deletion process.",
          },
          {
            condicao: "The subscription can be cancelled without a penalty.",
            estado: "rejeitada",
            prova: "Early cancellation is subject to a two-month service fee.",
            explicacao: "The stated fee contradicts cancellation without penalty.",
          },
          {
            condicao: "The policy identifies a response time for support requests.",
            estado: "incerta",
            prova: null,
            explicacao: "The page does not state a support response time.",
          },
        ],
        resumo:
          "Data deletion is confirmed, penalty-free cancellation is rejected and support timing remains uncertain.",
      },
      verificationId: "22222222-2222-4222-8222-222222222222",
      pageHash:
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    },
  },
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
      source: { type: "string", pattern: "^https?://[^\\s]+$" },
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
      source: { type: "string", pattern: "^https?://[^\\s]+$" },
      title: { type: "string" },
      verifiedAt: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
      },
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
      verificationId: {
        type: "string",
        pattern:
          "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
      },
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
