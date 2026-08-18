import { useEffect, useRef } from "react";
import { EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder as cmPlaceholder } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { tags } from "@lezer/highlight";
import { type CodeLanguage, languageForPath } from "@/components/codeLanguage";

export { languageForPath, type CodeLanguage };

function languageExtension(language: CodeLanguage) {
  switch (language) {
    case "yaml":
      return yaml();
    case "shell":
      return StreamLanguage.define(shell);
    case "dockerfile":
      return StreamLanguage.define(dockerFile);
    case "hcl":
      return StreamLanguage.define(ruby);
    case "properties":
      return StreamLanguage.define(properties);
    case "text":
      return [];
  }
}

/** Couleurs portées par des variables CSS (styles/code-editor.css) — le thème suit l'app. */
const appHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword], color: "var(--code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--code-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.atom, tags.null, tags.unit], color: "var(--code-number)" },
  { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.variableName)], color: "var(--code-property)" },
  { tag: [tags.typeName, tags.className, tags.tagName, tags.labelName], color: "var(--code-type)" },
  { tag: [tags.operator, tags.punctuation, tags.bracket, tags.separator], color: "var(--code-punctuation)" },
  { tag: [tags.meta, tags.processingInstruction, tags.documentMeta], color: "var(--code-meta)" },
  { tag: tags.invalid, color: "var(--color-critical)" },
]);

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: CodeLanguage;
  readOnly?: boolean | undefined;
  placeholder?: string | undefined;
  /** Déclenché par Ctrl+S / Cmd+S dans l'éditeur (le "Enregistrer la page" du navigateur est neutralisé). */
  onSave?: (() => void) | undefined;
  className?: string | undefined;
  ariaLabel?: string | undefined;
}

/** Éditeur de code CodeMirror 6 réutilisable (studio de templates, fichiers de workspace IaC) —
 * numéros de ligne, indentation auto, coloration selon `language`, thème sombre de l'app. */
export default function CodeEditor({ value, onChange, language, readOnly = false, placeholder, onSave, className, ariaLabel }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  const languageCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const placeholderCompartment = useRef(new Compartment());

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          dropCursor(),
          history(),
          indentOnInput(),
          bracketMatching(),
          indentUnit.of("  "),
          EditorView.lineWrapping,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          syntaxHighlighting(appHighlightStyle),
          languageCompartment.current.of(languageExtension(language)),
          readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
          placeholderCompartment.current.of(placeholder ? cmPlaceholder(placeholder) : []),
          EditorView.contentAttributes.of(ariaLabel ? { "aria-label": ariaLabel } : {}),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Création unique — valeur/langage/readOnly suivent via les effets dédiés ci-dessous.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: languageCompartment.current.reconfigure(languageExtension(language)) });
  }, [language]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: placeholderCompartment.current.reconfigure(placeholder ? cmPlaceholder(placeholder) : []) });
  }, [placeholder]);

  return <div ref={hostRef} className={className ? `code-editor ${className}` : "code-editor"} />;
}
