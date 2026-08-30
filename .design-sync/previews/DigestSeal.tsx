import { DigestSeal } from "@standing-orders/design";

const ground = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 8,
  alignItems: "flex-start",
  background: "var(--background, #0c0e12)",
  padding: 16,
  borderRadius: 8,
};

export function Default() {
  return (
    <div style={ground}>
      <DigestSeal digest="a24c72e6603f7829" />
    </div>
  );
}

export function CustomLabel() {
  return (
    <div style={ground}>
      <DigestSeal label="approved" digest="7bc26d4e91f0a3c2" />
      <DigestSeal label="head" digest="ca61cc6" />
    </div>
  );
}
