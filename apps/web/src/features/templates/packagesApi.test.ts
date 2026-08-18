import { describe, expect, it } from "vitest";
import { packageSearchDistro } from "./packagesApi";

describe("packageSearchDistro", () => {
  it("cloud-image : distro supportée, casse/espaces ignorés", () => {
    expect(packageSearchDistro({ type: "cloud-image", distro: "ubuntu", version: "24.04" })).toBe("ubuntu");
    expect(packageSearchDistro({ type: "cloud-image", distro: " Debian ", version: "12" })).toBe("debian");
    expect(packageSearchDistro({ type: "cloud-image", distro: "opensuse", version: "15" })).toBeNull();
  });

  it("container : déduit de l'image, registry/tag ignorés", () => {
    expect(packageSearchDistro({ type: "container", image: "debian:bookworm" })).toBe("debian");
    expect(packageSearchDistro({ type: "container", image: "docker.io/library/alpine:3.20" })).toBe("alpine");
    expect(packageSearchDistro({ type: "container", image: "ubuntu" })).toBe("ubuntu");
    expect(packageSearchDistro({ type: "container", image: "fedora:40" })).toBe("fedora");
    expect(packageSearchDistro({ type: "container", image: "archlinux:latest" })).toBe("arch");
    expect(packageSearchDistro({ type: "container", image: "scratch" })).toBeNull();
    expect(packageSearchDistro({ type: "container", image: "nginx:1.27" })).toBeNull();
  });

  it("mkosi : distro directe (arch inclus)", () => {
    expect(packageSearchDistro({ type: "mkosi", distro: "arch", release: "rolling" })).toBe("arch");
    expect(packageSearchDistro({ type: "mkosi", distro: "fedora", release: "40" })).toBe("fedora");
  });

  it("iso : jamais de recherche", () => {
    expect(packageSearchDistro({ type: "iso", imageUuid: "abc" })).toBeNull();
  });
});
