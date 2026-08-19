import { describe, expect, it } from "vitest";
import { randomCryptSalt, sha512Crypt } from "../src/services/iac/sha512crypt.js";

// Vecteurs officiels SHA-512 crypt (Ulrich Drepper), revérifiés dans le conteneur avec
// `openssl passwd -6 -salt <sel> <mot de passe>` — pas des valeurs recopiées de mémoire.
describe("sha512Crypt — vecteurs de référence crypt(3)/openssl passwd -6", () => {
  it("reproduit exactement les hashs d'openssl passwd -6", () => {
    expect(sha512Crypt("Hello world!", "saltstring")).toBe(
      "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1",
    );
    expect(sha512Crypt("This is just a test", "toolongsaltstring")).toBe(
      "$6$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0",
    );
  });

  it("tronque le sel à 16 caractères comme crypt(3)", () => {
    expect(sha512Crypt("x", "0123456789abcdefZZZZ")).toBe(sha512Crypt("x", "0123456789abcdef"));
  });

  it("gère un mot de passe long (>64 octets) et l'UTF-8", () => {
    const long = "a".repeat(200);
    expect(sha512Crypt(long, "saltsalt")).toMatch(/^\$6\$saltsalt\$[.\/0-9A-Za-z]{86}$/);
    expect(sha512Crypt("mot de passe éàü", "saltsalt")).toMatch(/^\$6\$saltsalt\$[.\/0-9A-Za-z]{86}$/);
  });

  it("randomCryptSalt : 16 caractères de l'alphabet crypt, jamais deux fois le même", () => {
    const salts = new Set(Array.from({ length: 50 }, () => randomCryptSalt()));
    expect(salts.size).toBe(50);
    for (const salt of salts) expect(salt).toMatch(/^[.\/0-9A-Za-z]{16}$/);
  });

  it("supporte un nombre de tours explicite (préfixe $6$rounds=)", () => {
    expect(sha512Crypt("Hello world!", "saltstring", 10_000)).toMatch(/^\$6\$rounds=10000\$saltstring\$/);
  });
});
