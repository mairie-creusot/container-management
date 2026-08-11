//! `@quai/wasm-core` — cœur Rust compilé en WebAssembly.
//!
//! Expose `diffManifests(desiredYaml, actualYaml) -> DiffResult` (voir
//! `ARCHITECTURE.md`, section "Interface WASM"), utilisé par `apps/api` pour
//! calculer la dérive GitOps entre l'état désiré (dépôt Git) et l'état réel
//! (cluster).

mod diff;

use diff::{diff_text, has_drift, DiffLine};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Résultat du diff, sérialisé côté JS/TS avec les clés `lines` /
/// `hasDrift` (camelCase) conformément au contrat `DiffResult` défini dans
/// `ARCHITECTURE.md`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffResult {
    lines: Vec<DiffLine>,
    has_drift: bool,
}

/// Normalise un document YAML en le parsant puis en le re-sérialisant, afin
/// que deux documents sémantiquement identiques mais formatés différemment
/// (indentation, guillemets, ordre des clés au sein d'une map, etc.)
/// produisent un diff textuel cohérent.
///
/// Reste robuste face à un YAML légèrement invalide : si le parsing échoue,
/// on retombe sur le texte brut d'origine plutôt que de paniquer, afin que
/// le diff texte brut ligne à ligne reste disponible en dernier recours.
fn normalize_yaml(raw: &str) -> String {
    match serde_yaml::from_str::<serde_yaml::Value>(raw) {
        Ok(value) => serde_yaml::to_string(&value).unwrap_or_else(|_| raw.to_string()),
        Err(_) => raw.to_string(),
    }
}

/// Diffe deux manifestes YAML (désiré vs réel) ligne à ligne et indique s'il
/// existe une dérive.
///
/// # Erreurs
/// Ne panique jamais sur un YAML invalide (voir [`normalize_yaml`]). La
/// seule source d'erreur JS possible est un échec (très improbable) de
/// sérialisation du résultat vers `JsValue`.
#[wasm_bindgen(js_name = diffManifests)]
pub fn diff_manifests(desired_yaml: &str, actual_yaml: &str) -> Result<JsValue, JsValue> {
    let desired_normalized = normalize_yaml(desired_yaml);
    let actual_normalized = normalize_yaml(actual_yaml);

    let lines = diff_text(&desired_normalized, &actual_normalized);
    let drifted = has_drift(&lines);

    let result = DiffResult {
        lines,
        has_drift: drifted,
    };

    serde_wasm_bindgen::to_value(&result).map_err(|err| {
        JsValue::from_str(&format!(
            "quai-wasm-core: échec de sérialisation du résultat de diff: {err}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_yaml_falls_back_to_raw_on_invalid_input() {
        // YAML volontairement invalide (deux-points sans espace suivi d'une
        // structure ambiguë) : ne doit jamais paniquer.
        let invalid = "not: [valid, yaml: structure";
        let normalized = normalize_yaml(invalid);
        assert_eq!(normalized, invalid);
    }

    #[test]
    fn normalize_yaml_reformats_equivalent_documents_identically() {
        // Style bloc et style flow, même contenu sémantique : la
        // normalisation (parse + re-sérialisation) doit produire le même
        // texte pour les deux.
        let block_style = "name: nginx\nreplicas: 3\n";
        let flow_style = "{name: nginx, replicas: 3}\n";
        assert_eq!(normalize_yaml(block_style), normalize_yaml(flow_style));
    }

    #[test]
    fn diff_manifests_reports_no_drift_for_identical_manifests() {
        let yaml = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: demo\n";
        let lines = diff_text(&normalize_yaml(yaml), &normalize_yaml(yaml));
        assert!(!has_drift(&lines));
    }

    #[test]
    fn diff_manifests_reports_drift_for_changed_manifests() {
        let desired = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: demo\nspec:\n  replicas: 3\n";
        let actual = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: demo\nspec:\n  replicas: 1\n";
        let lines = diff_text(&normalize_yaml(desired), &normalize_yaml(actual));
        assert!(has_drift(&lines));
    }
}
