// Catalogue d'images cloud officielles pour la base "cloud-image" du studio — URLs construites sur
// les schémas DOCUMENTÉS et stables des miroirs officiels (jamais un lien inventé : le frontend
// vérifie l'existence réelle via checkCloudImageUrl avant de laisser créer). La saisie libre d'une
// URL reste toujours possible côté studio.

export interface CloudImageEntry {
  version: string;
  label: string;
  url: string;
}

export interface CloudImageDistro {
  distro: string;
  label: string;
  versions: CloudImageEntry[];
}

const ubuntu = (v: string, label: string): CloudImageEntry => ({
  version: v,
  label,
  url: `https://cloud-images.ubuntu.com/releases/${v}/release/ubuntu-${v}-server-cloudimg-amd64.img`,
});
const debian = (num: string, codename: string): CloudImageEntry => ({
  version: num,
  label: `Debian ${num} (${codename})`,
  url: `https://cloud.debian.org/images/cloud/${codename}/latest/debian-${num}-genericcloud-amd64.qcow2`,
});
const rocky = (v: string): CloudImageEntry => ({
  version: v,
  label: `Rocky Linux ${v}`,
  url: `https://dl.rockylinux.org/pub/rocky/${v}/images/x86_64/Rocky-${v}-GenericCloud-Base.latest.x86_64.qcow2`,
});
const alma = (v: string): CloudImageEntry => ({
  version: v,
  label: `AlmaLinux ${v}`,
  url: `https://repo.almalinux.org/almalinux/${v}/cloud/x86_64/images/AlmaLinux-${v}-GenericCloud-latest.x86_64.qcow2`,
});

export const CLOUD_IMAGE_CATALOG: CloudImageDistro[] = [
  {
    distro: "ubuntu",
    label: "Ubuntu Server",
    versions: [
      ubuntu("24.04", "Ubuntu Server 24.04 LTS (noble)"),
      ubuntu("22.04", "Ubuntu Server 22.04 LTS (jammy)"),
      ubuntu("20.04", "Ubuntu Server 20.04 LTS (focal)"),
      ubuntu("25.04", "Ubuntu Server 25.04 (plucky)"),
    ],
  },
  {
    distro: "debian",
    label: "Debian",
    versions: [debian("13", "trixie"), debian("12", "bookworm"), debian("11", "bullseye")],
  },
  { distro: "rocky", label: "Rocky Linux", versions: [rocky("10"), rocky("9"), rocky("8")] },
  { distro: "alma", label: "AlmaLinux", versions: [alma("10"), alma("9"), alma("8")] },
];

// Anti-SSRF : la vérification HEAD n'accepte QUE les miroirs officiels du catalogue.
const ALLOWED_CHECK_HOSTS = new Set(["cloud-images.ubuntu.com", "cloud.debian.org", "dl.rockylinux.org", "repo.almalinux.org"]);

const CHECK_TIMEOUT_MS = 10_000;

export interface CloudImageCheckResult {
  ok: boolean;
  status: number;
  sizeBytes?: number;
}

export async function checkCloudImageUrl(rawUrl: string): Promise<CloudImageCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL`);
  }
  if (parsed.protocol !== "https:" || !ALLOWED_CHECK_HOSTS.has(parsed.hostname)) {
    throw new Error(`Only official cloud-image mirrors can be checked: ${Array.from(ALLOWED_CHECK_HOSTS).join(", ")}`);
  }
  const response = await fetch(parsed, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  const length = response.headers.get("content-length");
  const sizeBytes = length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
  return { ok: response.ok, status: response.status, ...(sizeBytes !== undefined ? { sizeBytes } : {}) };
}
