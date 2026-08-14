// Fixture exécutée dans un PROCESS ENFANT ISOLÉ (voir ../configProductionGuards.test.ts) —
// requireKey() (crypto.ts) n'est évalué qu'au premier appel réel de chiffrement (cache paresseux),
// jamais au chargement du module : on doit donc réellement appeler encryptSecret() ici pour
// déclencher le garde, une simple importation ne suffirait pas.
import { encryptSecret } from "../../src/services/crypto.js";
encryptSecret("probe-value");
process.stdout.write("OK");
