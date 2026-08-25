export const MCP_TOOL_DESCRIPTIONS = {
  consultar_ia:
    "Use para perguntas gerais que não exijam pesquisa web em tempo real. Devolve uma resposta concisa baseada no conhecimento do modelo; não abre URLs nem confirma factos atuais. Para analisar uma página, use analisar_url; para testar critérios com provas, use verificar_condicoes.",
  analisar_url:
    "Use para extrair uma página HTTP ou HTTPS pública e produzir um relatório limitado ao conteúdo encontrado, com resumo, factos, riscos e ações recomendadas. O objetivo opcional orienta o foco. Não consulta fontes externas; para decisões por critério com provas, use verificar_condicoes.",
  verificar_condicoes:
    "Use para testar entre 1 e 10 condições explícitas numa página HTTP ou HTTPS pública. Devolve, por condição, confirmada, rejeitada ou incerta com prova textual, além de source, verifiedAt, verificationId e pageHash. Se a página não provar a condição, o resultado é incerta.",
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
