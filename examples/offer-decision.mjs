// Apply to the response for this same offer. Pass the original required conditions.
export function decideOffer(required, verification) {
  if (!Array.isArray(required) || !required.length ||
      required.some(condition => typeof condition !== "string" || !condition.trim())) {
    throw new TypeError("Provide the original non-empty list of required conditions.");
  }
  const rows = verification?.decisao?.condicoes;
  const reasons = required.map(condition => {
    const matches = Array.isArray(rows) ? rows.filter(row => row?.condicao === condition) : [];
    const row = matches.length === 1 ? matches[0] : null;
    const quote = typeof row?.prova === "string" ? row.prova.trim() : "";
    const status = quote && ["confirmada", "rejeitada"].includes(row?.estado)
      ? row.estado : "incerta";
    return { condition, status, quote: quote || null };
  });
  let action = "review";
  if (reasons.some(reason => reason.status === "rejeitada")) action = "exclude";
  else if (reasons.every(reason => reason.status === "confirmada")) action = "recommend";
  return { action, reasons, source: verification?.source ?? null,
    verificationId: verification?.verificationId ?? null };
}
