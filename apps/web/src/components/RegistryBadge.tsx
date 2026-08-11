import type { RegistryKind } from "@/types";

const REGISTRY_META: Record<RegistryKind, { label: string; color: string }> = {
  dockerhub: { label: "Docker Hub", color: "var(--registry-dockerhub)" },
  ghcr: { label: "GHCR", color: "var(--registry-ghcr)" },
  gitlab: { label: "GitLab", color: "var(--registry-gitlab)" },
  harbor: { label: "Harbor", color: "var(--registry-harbor)" },
};

export function registryMeta(kind: RegistryKind) {
  return REGISTRY_META[kind];
}

interface RegistryBadgeProps {
  kind: RegistryKind;
}

export default function RegistryBadge({ kind }: RegistryBadgeProps) {
  const meta = registryMeta(kind);
  return (
    <span className="registry-badge" style={{ background: meta.color }}>
      {meta.label}
    </span>
  );
}
