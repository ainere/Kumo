import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--accent)", fontWeight: "500" },
  { tag: [tags.string, tags.regexp], color: "var(--ok)" },
  { tag: tags.comment, color: "var(--faint)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--warn)" },
  { tag: tags.heading, color: "var(--accent)", fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--accent)", textDecoration: "underline" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", background: "transparent", color: "var(--text)", fontSize: "11.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.5", overflow: "auto" },
  ".cm-content": { padding: "6px 0" },
  ".cm-gutters": { background: "transparent", border: "none", color: "var(--faint)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 10px" },
  ".cm-line": { padding: "0 10px 0 4px" },
});

/**
 * A read-only code view. CodeMirror draws only the lines on screen, so the
 * largest file the Files tab opens scrolls as easily as a small one.
 */
export function CodeViewer({ path, content }: { path: string; content: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const shownPath = useRef(path);

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current as HTMLDivElement,
      state: EditorState.create({
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ tabindex: "0", "aria-label": "File contents" }),
          lineNumbers(),
          syntaxHighlighting(highlight),
          language.current.of([]),
          theme,
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    // A refresh with the same text leaves the scroll position alone.
    if (editor.state.doc.toString() !== content) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content } });
    }
    if (shownPath.current !== path) {
      shownPath.current = path;
      editor.dispatch({ effects: EditorView.scrollIntoView(0) });
    }
  }, [path, content]);

  useEffect(() => {
    let active = true;
    const apply = (support: Parameters<Compartment["reconfigure"]>[0]) => {
      if (active) view.current?.dispatch({ effects: language.current.reconfigure(support) });
    };
    const description = LanguageDescription.matchFilename(languages, path);
    if (description) description.load().then(apply, () => apply([]));
    else apply([]);
    return () => {
      active = false;
    };
  }, [path]);

  return <div ref={host} className="wb-code-view" data-part="code-view" />;
}
