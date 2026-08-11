//! Diff ligne à ligne fondé sur l'algorithme LCS (Longest Common Subsequence).
//!
//! Implémentation Rust pure, sans dépendance externe de diff : programmation
//! dynamique classique en O(n*m) qui reconstruit ensuite une séquence
//! d'opérations `context` / `add` / `remove` équivalente à un diff de type
//! Myers pour un usage ligne à ligne (suffisant et prévisible pour des
//! manifestes YAML, qui restent de taille modeste).

use serde::{Deserialize, Serialize};

/// Nature d'une ligne du diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    Context,
    Add,
    Remove,
}

/// Une ligne du diff, avec sa nature et son contenu texte (sans terminateur
/// de ligne).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
}

/// Calcule le diff ligne à ligne entre `old` et `new` via l'algorithme LCS.
///
/// Retourne une séquence de `DiffLine` : les lignes communes (dans l'ordre)
/// sont marquées `Context`, les lignes présentes uniquement dans `old` sont
/// marquées `Remove`, celles présentes uniquement dans `new` sont marquées
/// `Add`.
pub fn diff_lines(old: &[&str], new: &[&str]) -> Vec<DiffLine> {
    let n = old.len();
    let m = new.len();

    // dp[i][j] = longueur de la LCS de old[i..] et new[j..]
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if old[i] == new[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }

    let mut result = Vec::with_capacity(n + m);
    let mut i = 0usize;
    let mut j = 0usize;
    while i < n && j < m {
        if old[i] == new[j] {
            result.push(DiffLine {
                kind: DiffKind::Context,
                text: old[i].to_string(),
            });
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            result.push(DiffLine {
                kind: DiffKind::Remove,
                text: old[i].to_string(),
            });
            i += 1;
        } else {
            result.push(DiffLine {
                kind: DiffKind::Add,
                text: new[j].to_string(),
            });
            j += 1;
        }
    }
    while i < n {
        result.push(DiffLine {
            kind: DiffKind::Remove,
            text: old[i].to_string(),
        });
        i += 1;
    }
    while j < m {
        result.push(DiffLine {
            kind: DiffKind::Add,
            text: new[j].to_string(),
        });
        j += 1;
    }

    result
}

/// Découpe deux textes en lignes puis calcule leur diff. Ne conserve pas les
/// terminateurs de ligne (comportement de `str::lines()`), et gère
/// correctement les textes vides (aucune ligne).
pub fn diff_text(old: &str, new: &str) -> Vec<DiffLine> {
    let old_lines: Vec<&str> = split_lines(old);
    let new_lines: Vec<&str> = split_lines(new);
    diff_lines(&old_lines, &new_lines)
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.lines().collect()
    }
}

/// Vrai dès qu'au moins une ligne du diff n'est pas du contexte, c'est-à-dire
/// dès qu'il existe une différence (`add` ou `remove`) entre les deux
/// documents.
pub fn has_drift(lines: &[DiffLine]) -> bool {
    lines.iter().any(|l| l.kind != DiffKind::Context)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_yaml_has_no_drift() {
        let a = "a: 1\nb: 2\nc: 3\n";
        let d = diff_text(a, a);
        assert!(d.iter().all(|l| l.kind == DiffKind::Context));
        assert!(!has_drift(&d));
        assert_eq!(d.len(), 3);
    }

    #[test]
    fn one_line_modified() {
        let old = "a: 1\nb: 2\nc: 3\n";
        let new = "a: 1\nb: 20\nc: 3\n";
        let d = diff_text(old, new);

        assert!(has_drift(&d));

        let removes: Vec<_> = d.iter().filter(|l| l.kind == DiffKind::Remove).collect();
        let adds: Vec<_> = d.iter().filter(|l| l.kind == DiffKind::Add).collect();
        let context: Vec<_> = d.iter().filter(|l| l.kind == DiffKind::Context).collect();

        assert_eq!(removes.len(), 1);
        assert_eq!(adds.len(), 1);
        assert_eq!(context.len(), 2);
        assert_eq!(removes[0].text, "b: 2");
        assert_eq!(adds[0].text, "b: 20");
    }

    #[test]
    fn one_line_added() {
        let old = "a: 1\nc: 3\n";
        let new = "a: 1\nb: 2\nc: 3\n";
        let d = diff_text(old, new);

        assert!(has_drift(&d));

        let adds: Vec<_> = d.iter().filter(|l| l.kind == DiffKind::Add).collect();
        assert_eq!(adds.len(), 1);
        assert_eq!(adds[0].text, "b: 2");
        assert!(d.iter().all(|l| l.kind != DiffKind::Remove));
    }

    #[test]
    fn one_line_removed() {
        let old = "a: 1\nb: 2\nc: 3\n";
        let new = "a: 1\nc: 3\n";
        let d = diff_text(old, new);

        assert!(has_drift(&d));

        let removes: Vec<_> = d.iter().filter(|l| l.kind == DiffKind::Remove).collect();
        assert_eq!(removes.len(), 1);
        assert_eq!(removes[0].text, "b: 2");
        assert!(d.iter().all(|l| l.kind != DiffKind::Add));
    }

    #[test]
    fn both_empty_have_no_drift() {
        let d = diff_text("", "");
        assert!(d.is_empty());
        assert!(!has_drift(&d));
    }

    #[test]
    fn empty_old_yields_only_additions() {
        let d = diff_text("", "a: 1\nb: 2\n");
        assert!(has_drift(&d));
        assert_eq!(d.len(), 2);
        assert!(d.iter().all(|l| l.kind == DiffKind::Add));
    }

    #[test]
    fn empty_new_yields_only_removals() {
        let d = diff_text("a: 1\nb: 2\n", "");
        assert!(has_drift(&d));
        assert_eq!(d.len(), 2);
        assert!(d.iter().all(|l| l.kind == DiffKind::Remove));
    }

    #[test]
    fn reordered_lines_are_add_and_remove_not_context() {
        // Un simple LCS ligne à ligne ne "comprend" pas le YAML : une
        // permutation de lignes ressort comme suppression + ajout, ce qui
        // est le comportement attendu pour un diff texte brut.
        let old = "a: 1\nb: 2\n";
        let new = "b: 2\na: 1\n";
        let d = diff_text(old, new);
        assert!(has_drift(&d));
    }
}
