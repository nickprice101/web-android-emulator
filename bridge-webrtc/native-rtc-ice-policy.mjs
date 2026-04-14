const VALID_ICE_TRANSPORT_POLICIES = new Set(["all", "relay"]);

export function normalizeIceTransportPolicy(value, fallback = "all") {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (VALID_ICE_TRANSPORT_POLICIES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

export function resolveNativeRtcPeerIceTransportPolicy(startSignal) {
  return normalizeIceTransportPolicy(startSignal?.iceTransportPolicy, "all");
}
