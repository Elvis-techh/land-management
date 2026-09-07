import { useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";

/**
 * Turn any element into a place files can be dropped.
 *
 * Extracted from `ProofDropzone`, which owned this behaviour alone, the day a
 * SECOND screen needed it: the comprobante usually arrives hours after the
 * payment was recorded — the customer sends it that evening — so it is filed
 * from the correction dialog, not from the form that took the money. That
 * dialog had a file picker and nothing else, so the gesture the whole feature
 * was built around (drag the screenshot straight out of WhatsApp) worked in
 * the one place it was least needed.
 *
 * Behaviour only. It says nothing about what the drop target looks like or
 * what happens to the files, so the two screens can keep uploading on entirely
 * different schedules — one holds the files until the receipt exists, the
 * other sends them the moment they land.
 */
export function useFileDrop(
  onFiles: (files: FileList) => void,
  disabled = false,
): { isDraggingOver: boolean; dropHandlers: Record<string, (event: ReactDragEvent) => void> } {
  const [isDraggingOver, setDraggingOver] = useState(false);

  /**
   * Counts enter/leave rather than toggling a boolean.
   *
   * `dragleave` fires every time the pointer crosses into a CHILD element, so a
   * plain boolean makes the highlight flicker off as soon as the cursor passes
   * over the icon or the text inside the zone. Depth reaches zero only when the
   * pointer has genuinely left.
   */
  const dragDepth = useRef(0);

  return {
    isDraggingOver,
    dropHandlers: {
      onDragEnter: (event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDraggingOver(true);
      },
      onDragOver: (event) => {
        // Without preventDefault the browser navigates to the dropped file,
        // which loses the form and everything typed into it.
        event.preventDefault();
      },
      onDragLeave: (event) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDraggingOver(false);
        }
      },
      onDrop: (event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDraggingOver(false);

        if (!disabled) {
          onFiles(event.dataTransfer.files);
        }
      },
    },
  };
}

/**
 * What `dataTransfer.types` contains when a drag carries files rather than
 * text. Everything else in that list is a MIME type; this one is a bare word.
 */
const FILES = "Files";

/** What a drag landing on the window as a whole should be allowed to do. */
export type WindowDropAction =
  /** Not ours. Let the browser and the page do whatever they normally do. */
  | "ignore"
  /** Swallow it so the browser does not navigate, but start nothing. */
  | "block"
  /** Take the files. */
  | "accept";

/**
 * Decide what a window-wide file drop does, given what else is on screen.
 *
 * Pure and exported so the rule can be read and tested without a browser: it
 * runs on every drag that crosses this app, and each of the three answers is
 * there to stop a specific, expensive mistake.
 *
 * - `ignore` for a drag carrying no files. The dashboard's section bars are
 *   `draggable` and a page full of text is selectable, so plenty of drags here
 *   are not file drops and must be left entirely alone.
 * - `ignore`, too, when a dropzone nearer the pointer has already called
 *   `preventDefault` — the receipt panel's own zone attaches to the receipt you
 *   are looking at, and it has to keep winning over the window behind it, or
 *   one gesture would both attach the slip and open a form for a second one.
 * - `block` rather than `accept` when this app cannot take the file right now.
 *   Dropping a file on a page the browser does not handle makes it NAVIGATE to
 *   that file: the app is replaced by a JPEG, and a half-typed receipt form
 *   goes with it. That is worth preventing whether or not we want the file.
 */
export function windowDropAction(drag: {
  types: readonly string[];
  /** A dropzone under the pointer already claimed this drag. */
  handledNearer: boolean;
  /** Is the app in a state where a dropped comprobante can go somewhere? */
  accepting: boolean;
}): WindowDropAction {
  if (!drag.types.includes(FILES)) {
    return "ignore";
  }

  if (drag.handledNearer) {
    return "ignore";
  }

  return drag.accepting ? "accept" : "block";
}

function carriesFiles(transfer: DataTransfer | null): boolean {
  // `types` is a live `DOMStringList` in some browsers and a plain array in
  // others, so it is copied before being read rather than trusted to have
  // `includes`.
  return transfer !== null && Array.from(transfer.types).includes(FILES);
}

/** What is happening with a file being dragged across the app right now. */
export interface WindowFileDrag {
  /**
   * Files are somewhere over the app.
   *
   * True even where this hook will not take them — over an open dialog, or
   * over a dropzone of its own. It answers "is a file looking for somewhere to
   * go", which is the moment to SHOW the places it can go, wherever they are.
   */
  isDraggingFiles: boolean;
  /**
   * …and the window at large is what would take them.
   *
   * False while the pointer is over a dropzone that has claimed the drag, so
   * the full-window invitation gets out of the way of the specific one rather
   * than talking over it.
   */
  isWindowTarget: boolean;
}

/**
 * Make the whole window a place to drop a comprobante.
 *
 * The visible dropzone is inside the receipt form, which is precisely the
 * screen you have not opened yet when the slip arrives. The gesture this
 * serves is one motion: the screenshot comes in on WhatsApp Web in the next
 * window, and it goes onto Lindero — anywhere on Lindero — and the form opens
 * around it. Aiming is not part of the job.
 *
 * It is also the desktop half of a feature that only had a phone half. Sharing
 * into an installed app is Android-only (see lib/sharedIntake.ts), and the
 * office works on Windows and Linux, where dragging is the equivalent gesture
 * and there was nothing to drag onto.
 *
 * Reports back on the drag rather than just swallowing it, because a target
 * nobody can see is a target nobody discovers — and because on a screen with
 * more than one target, which one is about to take the file is the only
 * question the person dragging it has.
 */
export function useWindowFileDrop(
  onFiles: (files: File[]) => void,
  disabled = false,
): WindowFileDrag {
  const [isDraggingOver, setDraggingOver] = useState(false);

  /*
   * Is a dropzone under the pointer claiming this drag?
   *
   * Kept apart from `isDraggingOver` because the two answer different
   * questions and change at different moments: files can be over the app for
   * the whole gesture while the thing that would receive them changes every
   * time the pointer crosses into a zone and out again.
   */
  const [isClaimedNearer, setClaimedNearer] = useState(false);

  /* The listeners below are attached once, on mount, so they must not close
     over a render's values. These refs are how they read the current ones. */
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  /* Same enter/leave count as the element hook above, for the same reason:
     `dragleave` fires on every crossing into a child, and here every element in
     the app is a child. */
  const dragDepth = useRef(0);

  useEffect(() => {
    const decide = (event: DragEvent): WindowDropAction =>
      windowDropAction({
        types: event.dataTransfer === null ? [] : Array.from(event.dataTransfer.types),
        // The zone under the pointer, if there was one, called preventDefault
        // on its way past. Reading it here means a new dropzone anywhere in the
        // app takes precedence over this one without having to say so.
        handledNearer: event.defaultPrevented,
        accepting: !disabledRef.current,
      });

    const handleDragEnter = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) {
        return;
      }

      dragDepth.current += 1;
      setDraggingOver(true);
    };

    const handleDragLeave = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) {
        return;
      }

      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDraggingOver(false);
        setClaimedNearer(false);
      }
    };

    const handleDragOver = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) {
        return;
      }

      /*
       * Read BEFORE this handler preventDefaults anything, so it can only be
       * true because a dropzone nearer the pointer got there first.
       *
       * `dragover` is what this rides on rather than enter/leave: it fires
       * continuously for as long as the drag is over the page, so the answer
       * refreshes as the pointer crosses in and out of a zone without having to
       * pair up enter and leave events per element.
       */
      setClaimedNearer(event.defaultPrevented);

      const action = decide(event);

      if (action === "ignore") {
        return;
      }

      // Without this on EVERY dragover, no drop event is ever fired.
      event.preventDefault();

      if (event.dataTransfer !== null) {
        // Copy shows a "+" under the cursor; "none" shows the barred circle,
        // which is the honest answer while a dialog owns the screen.
        event.dataTransfer.dropEffect = action === "accept" ? "copy" : "none";
      }
    };

    const handleDrop = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) {
        return;
      }

      // The drag is over however this ends — no dragleave follows a drop — so
      // the highlight is cleared before deciding anything, including when the
      // files are somebody else's to handle.
      dragDepth.current = 0;
      setDraggingOver(false);
      setClaimedNearer(false);

      const action = decide(event);

      if (action === "ignore") {
        return;
      }

      event.preventDefault();

      if (action === "accept") {
        const files = Array.from(event.dataTransfer?.files ?? []);

        if (files.length > 0) {
          onFilesRef.current(files);
        }
      }
    };

    // A drag that started inside the page and was abandoned. Files dragged in
    // from another app never fire this, which is why the count above exists.
    const handleDragEnd = () => {
      dragDepth.current = 0;
      setDraggingOver(false);
      setClaimedNearer(false);
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragend", handleDragEnd);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragend", handleDragEnd);
      dragDepth.current = 0;
    };
  }, []);

  return {
    isDraggingFiles: isDraggingOver,
    /* Turned off mid-drag — a dialog opened while a file hovered — the
       invitation has to go even though no dragleave has arrived to take it
       down. Likewise once a nearer zone has claimed the drag. */
    isWindowTarget: isDraggingOver && !disabled && !isClaimedNearer,
  };
}
