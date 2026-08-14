// Fixture exécutée dans un PROCESS ENFANT ISOLÉ (voir ../configProductionGuards.test.ts) —
// importer config.ts déclenche le garde de démarrage (throw si NODE_ENV=production et JWT_SECRET
// absent/laissé à sa valeur par défaut de dev, voir src/config.ts). On ne peut pas exercer ce
// comportement dans le process vitest principal : un throw au chargement du module casserait
// toute la suite (config.ts est déjà importé ailleurs). stdout "OK:<secret>" = démarrage normal ;
// code de sortie non nul + message sur stderr = garde déclenché.
import { config } from "../../src/config.js";
process.stdout.write(`OK:${config.session.jwtSecret}`);
