const expectedProtocols = [
  { match: /youtube/i, protocol: "YouTube" },
  { match: /instagram|meta|facebook/i, protocol: "Instagram/Facebook" },
  { match: /telegram/i, protocol: "Telegram" },
  { match: /yandex/i, protocol: "Yandex" },
  { match: /vk|mail\.ru/i, protocol: "VK/MailRu" },
  { match: /apple|icloud/i, protocol: "Apple" },
  { match: /google/i, protocol: "Google" },
  { match: /microsoft/i, protocol: "Microsoft" },
  { match: /openai|chatgpt/i, protocol: "OpenAI" },
  { match: /dropbox/i, protocol: "Dropbox" },
  { match: /github/i, protocol: "GitHub" },
];

export function expectedNdpiProtocol(appFamily) {
  const value = String(appFamily || "");
  const rule = expectedProtocols.find((item) => item.match.test(value));
  return rule?.protocol || "";
}

export function ndpiDiagnosticForApp(row, diagnostics = []) {
  const expected = expectedNdpiProtocol(row?.app_family);
  const samples = Array.isArray(row?.sample_domains) ? row.sample_domains : [];
  const match = diagnostics.find((item) => {
    const family = String(item.app_family || "").toLowerCase();
    if (family && family === String(row?.app_family || "").toLowerCase()) return true;
    const domain = String(item.domain || item.hostname || "").toLowerCase();
    return domain && samples.some((sample) => String(sample || "").toLowerCase() === domain);
  });
  if (!match) {
    return {
      status: "not sampled",
      expected,
      protocol: "",
      detail: expected ? "nDPI sample not available" : "no nDPI expectation",
    };
  }
  const protocol = String(match.ndpi_protocol || match.protocol || match.app_protocol || "");
  const expectedOk = expected && protocol.toLowerCase().includes(expected.toLowerCase());
  return {
    status: expectedOk ? "match" : "review",
    expected,
    protocol,
    detail: match.source || "offline nDPI diagnostic",
  };
}

