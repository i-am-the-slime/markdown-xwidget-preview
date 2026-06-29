;;; markdown-xwidget-preview.el --- Markdown live preview in Emacs xwidgets -*- lexical-binding: t; -*-

;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1") (markdown-mode "2.6"))
;; Keywords: markdown, preview, xwidget
;; URL: https://github.com/local/markdown-xwidget-preview

;;; Commentary:
;; Live Markdown preview in an Emacs xwidget-webkit buffer, backed by the
;; bundled Vite/React renderer in ../preview.

;;; Code:

(require 'face-remap)
(require 'project nil t)
(require 'seq)
(require 'subr-x)
(require 'url-parse)
(require 'browse-url)
(require 'xwidget nil t)

(defgroup markdown-xwidget-preview nil
  "Preview Markdown through a local web dev server in xwidgets."
  :group 'tools)

(defvar markdown-xwidget-preview-extension-root
  (let ((directory (file-name-directory (file-truename (or load-file-name buffer-file-name)))))
    (if (file-directory-p (expand-file-name "preview" directory))
        directory
      (expand-file-name ".." directory)))
  "Root directory of the bundled Markdown preview extension.")

(defcustom markdown-xwidget-preview-command '("bun" "dev")
  "Command used to start the Markdown dev server."
  :type '(repeat string))

(defcustom markdown-xwidget-preview-install-dependencies-on-start t
  "When non-nil, run `bun install --frozen-lockfile' if dependencies are missing."
  :type 'boolean)

(defcustom markdown-xwidget-preview-url "http://127.0.0.1:5173/"
  "URL opened in the xwidget preview."
  :type 'string)

(defcustom markdown-xwidget-preview-project-root
  (expand-file-name "preview" markdown-xwidget-preview-extension-root)
  "Directory containing the Markdown preview web app."
  :type 'directory)

(defcustom markdown-xwidget-preview-root-files
  '("package.json" "bun.lock" "bun.lockb" "pnpm-lock.yaml" "yarn.lock" ".git")
  "Files/directories used to find the project root."
  :type '(repeat string))

(defcustom markdown-xwidget-preview-reload-on-save nil
  "When non-nil, force a full preview reload after saving."
  :type 'boolean)

(defcustom markdown-xwidget-preview-hide-webkit-chrome t
  "When non-nil, hide Emacs mode/header lines in preview buffers."
  :type 'boolean)

(defcustom markdown-xwidget-preview-buffer-name "Preview"
  "Buffer name used for Markdown preview xwidget buffers."
  :type 'string)

(defcustom markdown-xwidget-preview-window-padding 1
  "Side padding, in Emacs columns, around preview xwidget windows."
  :type 'integer)

(defcustom markdown-xwidget-preview-kill-server-on-emacs-exit t
  "When non-nil, stop the preview server when Emacs exits."
  :type 'boolean)

(defcustom markdown-xwidget-preview-kill-server-on-buffer-kill nil
  "When non-nil, stop the preview server when a preview source buffer is killed."
  :type 'boolean)

(defcustom markdown-xwidget-preview-kill-server-on-preview-kill t
  "When non-nil, stop the preview server when the xwidget preview is killed."
  :type 'boolean)

(defcustom markdown-xwidget-preview-clean-artifacts-on-preview-kill t
  "When non-nil, delete generated artifacts on preview buffer kill."
  :type 'boolean)

(defcustom markdown-xwidget-preview-clean-artifacts-on-start t
  "When non-nil, delete stale generated artifacts before server start."
  :type 'boolean)

(defcustom markdown-xwidget-preview-highlight-cursor t
  "When non-nil, highlight the current Markdown block in the preview."
  :type 'boolean)

(defcustom markdown-xwidget-preview-live-edits t
  "When non-nil, send unsaved buffer edits to the preview."
  :type 'boolean)

(defcustom markdown-xwidget-preview-live-edit-delay 0
  "Idle delay before sending unsaved edits to the preview.
A value of 0 sends each edit immediately as a splice."
  :type 'number)

(defcustom markdown-xwidget-preview-insert-column-offset 0
  "Columns to advance the preview caret while Evil is in insert state."
  :type 'integer)

(defcustom markdown-xwidget-preview-source-list-marker "❧"
  "Glyph used to prettify Markdown list markers in the source buffer.
Set to nil to keep literal Markdown markers visible."
  :type '(choice (const nil) string))

(defcustom markdown-xwidget-preview-source-heading-font-family "Tiempos Fine"
  "Font family used for Markdown headings in the source buffer.
Set to nil to keep the theme's heading font."
  :type '(choice (const nil) string))

(defcustom markdown-xwidget-preview-source-body-font-family "Inter Variable"
  "Font family used for non-code Markdown source text.
Set to nil to keep the theme's body font."
  :type '(choice (const nil) string))

(defcustom markdown-xwidget-preview-source-code-font-family "Berkeley Mono"
  "Font family used for Markdown source code blocks and inline code."
  :type '(choice (const nil) string))

(defcustom markdown-xwidget-preview-source-code-background nil
  "Background used for Markdown code blocks in the source buffer.
Set to nil to keep the theme's code-block background."
  :type '(choice (const nil) string))

(defvar markdown-xwidget-preview--process nil)
(defvar markdown-xwidget-preview--buffer-name "*markdown-preview-dev-server*")
(defvar markdown-xwidget-preview--external-title-prefix "__markdown_external_link__")
(defvar-local markdown-xwidget-preview--last-highlighted-position nil)
(defvar-local markdown-xwidget-preview--live-edit-timer nil)
(defvar-local markdown-xwidget-preview--browser-in-sync nil)
(defvar-local markdown-xwidget-preview--source-face-remaps nil)
(defvar-local markdown-xwidget-preview--preview-buffer nil)

(defvar markdown-xwidget-preview--source-font-lock-keywords
  '((markdown-xwidget-preview--compose-source-list-marker)))

(defvar-keymap markdown-xwidget-preview-mode-map
  :doc "Keymap for `markdown-xwidget-preview-mode'."
  "C-c C-p" #'markdown-xwidget-preview-open-beside
  "C-c C-o" #'markdown-xwidget-preview-open
  "C-c C-r" #'markdown-xwidget-preview-reload
  "C-c C-R" #'markdown-xwidget-preview-restart
  "C-c C-s" #'markdown-xwidget-preview-start
  "C-c C-k" #'markdown-xwidget-preview-stop
  "C-c C-?" #'markdown-xwidget-preview-status)

(defun markdown-xwidget-preview--compose-source-list-marker (limit)
  "Compose Markdown list markers before LIMIT."
  (when (and markdown-xwidget-preview-source-list-marker
             (re-search-forward "^\\([[:space:]]*\\)\\([-*+]\\)\\([[:space:]]\\)" limit t))
    (compose-region (match-beginning 2) (match-end 2) markdown-xwidget-preview-source-list-marker)
    t))

(defun markdown-xwidget-preview--heading-faces ()
  "Return Markdown heading faces that exist in this Emacs."
  (seq-filter #'facep
              '(markdown-header-face
                markdown-header-face-1
                markdown-header-face-2
                markdown-header-face-3
                markdown-header-face-4
                markdown-header-face-5
                markdown-header-face-6)))

(defun markdown-xwidget-preview--code-faces ()
  "Return Markdown code faces that exist in this Emacs."
  (seq-filter #'facep
              '(markdown-code-face
                markdown-inline-code-face
                markdown-pre-face
                markdown-language-keyword-face
                markdown-gfm-checkbox-face)))

(defun markdown-xwidget-preview--remember-face-remap (cookie)
  "Remember face remap COOKIE for later cleanup."
  (push cookie markdown-xwidget-preview--source-face-remaps))

(defun markdown-xwidget-preview--enable-source-body-font ()
  "Use the preview body font in the source buffer."
  (when markdown-xwidget-preview-source-body-font-family
    (markdown-xwidget-preview--remember-face-remap
     (face-remap-add-relative
      'default
      `(:family ,markdown-xwidget-preview-source-body-font-family)))))

(defun markdown-xwidget-preview--enable-source-heading-font ()
  "Use the preview heading font in the source buffer."
  (when markdown-xwidget-preview-source-heading-font-family
    (dolist (face (markdown-xwidget-preview--heading-faces))
      (markdown-xwidget-preview--remember-face-remap
       (face-remap-add-relative
        face
        `(:family ,markdown-xwidget-preview-source-heading-font-family))))))

(defun markdown-xwidget-preview--source-code-face-attributes ()
  "Return source code face attributes."
  (append
   (when markdown-xwidget-preview-source-code-font-family
     `(:family ,markdown-xwidget-preview-source-code-font-family))
   (when markdown-xwidget-preview-source-code-background
     `(:background ,markdown-xwidget-preview-source-code-background))))

(defun markdown-xwidget-preview--enable-source-code-face ()
  "Use a distinct face for Markdown code in the source buffer."
  (let ((attributes (markdown-xwidget-preview--source-code-face-attributes)))
    (when attributes
      (dolist (face (markdown-xwidget-preview--code-faces))
        (markdown-xwidget-preview--remember-face-remap
         (face-remap-add-relative face attributes))))))

(defun markdown-xwidget-preview--disable-source-face-remaps ()
  "Remove source face remaps."
  (mapc #'face-remap-remove-relative markdown-xwidget-preview--source-face-remaps)
  (setq markdown-xwidget-preview--source-face-remaps nil))

(defun markdown-xwidget-preview--enable-source-pretties ()
  "Enable source-buffer prettification."
  (font-lock-add-keywords nil markdown-xwidget-preview--source-font-lock-keywords 'append)
  (markdown-xwidget-preview--enable-source-body-font)
  (markdown-xwidget-preview--enable-source-heading-font)
  (markdown-xwidget-preview--enable-source-code-face)
  (font-lock-flush))

(defun markdown-xwidget-preview--disable-source-pretties ()
  "Disable source-buffer prettification."
  (font-lock-remove-keywords nil markdown-xwidget-preview--source-font-lock-keywords)
  (markdown-xwidget-preview--disable-source-face-remaps)
  (remove-text-properties (point-min) (point-max) '(composition nil))
  (font-lock-flush))

(defun markdown-xwidget-preview-root ()
  "Return a plausible Markdown project root."
  (or (when markdown-xwidget-preview-project-root
        (expand-file-name markdown-xwidget-preview-project-root))
      (when-let* ((project (and (fboundp 'project-current) (project-current nil))))
        (expand-file-name (project-root project)))
      (seq-some (lambda (file)
                  (when-let* ((root (locate-dominating-file default-directory file)))
                    (expand-file-name root)))
                markdown-xwidget-preview-root-files)
      default-directory))

(defun markdown-xwidget-preview-install-dependencies ()
  "Install preview web app dependencies when missing."
  (interactive)
  (let ((default-directory (file-name-as-directory markdown-xwidget-preview-project-root)))
    (when (and markdown-xwidget-preview-install-dependencies-on-start
               (file-exists-p (expand-file-name "package.json" default-directory))
               (not (file-directory-p (expand-file-name "node_modules" default-directory))))
      (message "Installing Markdown preview dependencies in %s" default-directory)
      (let ((exit-code (call-process "bun" nil markdown-xwidget-preview--buffer-name t
                                     "install" "--frozen-lockfile")))
        (unless (zerop exit-code)
          (user-error "Failed to install Markdown preview dependencies"))))))

(defun markdown-xwidget-preview-start ()
  "Start the configured Markdown dev server unless it is already running."
  (interactive)
  (if (process-live-p markdown-xwidget-preview--process)
      (message "Markdown preview server already running")
    (markdown-xwidget-preview-install-dependencies)
    (when markdown-xwidget-preview-clean-artifacts-on-start
      (markdown-xwidget-preview-clean-artifacts))
    (let* ((default-directory (markdown-xwidget-preview-root))
           (buffer (get-buffer-create markdown-xwidget-preview--buffer-name))
           (program (car markdown-xwidget-preview-command))
           (args (cdr markdown-xwidget-preview-command)))
      (setq markdown-xwidget-preview--process
            (apply #'start-process "markdown-preview" buffer program args))
      (set-process-sentinel markdown-xwidget-preview--process
                            #'markdown-xwidget-preview--process-sentinel)
      (set-process-query-on-exit-flag markdown-xwidget-preview--process nil)
      (message "Started Markdown preview server in %s: %s"
               default-directory
               (string-join markdown-xwidget-preview-command " ")))))

(defun markdown-xwidget-preview--process-sentinel (process _event)
  "Forget PROCESS when the preview server exits."
  (unless (process-live-p process)
    (when (eq process markdown-xwidget-preview--process)
      (setq markdown-xwidget-preview--process nil))))

(defun markdown-xwidget-preview-stop ()
  "Stop the Markdown dev server started by `markdown-xwidget-preview-start'."
  (interactive)
  (when (process-live-p markdown-xwidget-preview--process)
    (interrupt-process markdown-xwidget-preview--process)
    (run-at-time 0.5 nil #'markdown-xwidget-preview--kill-if-live
                 markdown-xwidget-preview--process))
  (setq markdown-xwidget-preview--process nil)
  (message "Stopped Markdown preview server"))

(defun markdown-xwidget-preview--kill-if-live (process)
  "Kill PROCESS if it ignored the graceful stop signal."
  (when (process-live-p process)
    (kill-process process)))

(defun markdown-xwidget-preview-clean-artifacts ()
  "Delete generated preview artifacts from the bundled web app."
  (interactive)
  (let ((default-directory (file-name-as-directory markdown-xwidget-preview-project-root)))
    (dolist (path '("dist" ".vite" "node_modules/.vite"))
      (let ((expanded (expand-file-name path default-directory)))
        (when (file-exists-p expanded)
          (delete-directory expanded t))))
    (dolist (file (directory-files default-directory t "\\.log\\'"))
      (delete-file file))))

(defun markdown-xwidget-preview-status ()
  "Report preview server status."
  (interactive)
  (if (process-live-p markdown-xwidget-preview--process)
      (message "Markdown preview server running: %s" markdown-xwidget-preview-url)
    (message "Markdown preview server is not running from Emacs")))

(defun markdown-xwidget-preview--stop-on-exit ()
  "Stop managed preview server when Emacs exits."
  (when markdown-xwidget-preview-kill-server-on-emacs-exit
    (markdown-xwidget-preview-stop)))

(add-hook 'kill-emacs-hook #'markdown-xwidget-preview--stop-on-exit)

(defun markdown-xwidget-preview--frame-preview-buffers (frame)
  "Return preview buffers shown in FRAME."
  (seq-uniq
   (seq-keep (lambda (window)
               (let ((buffer (window-buffer window)))
                 (when (buffer-local-value 'markdown-xwidget-preview--preview-buffer buffer)
                   buffer)))
             (window-list frame 'no-minibuf))))

(defun markdown-xwidget-preview--delete-frame (frame)
  "Clean up preview buffers and server when FRAME is deleted."
  (let ((buffers (markdown-xwidget-preview--frame-preview-buffers frame)))
    (when buffers
      (let ((markdown-xwidget-preview-kill-server-on-preview-kill nil))
        (mapc #'kill-buffer buffers))
      (markdown-xwidget-preview-stop))))

(add-hook 'delete-frame-functions #'markdown-xwidget-preview--delete-frame)

(defun markdown-xwidget-preview-restart ()
  "Restart the configured Markdown dev server."
  (interactive)
  (markdown-xwidget-preview-stop)
  (markdown-xwidget-preview-start))

(defun markdown-xwidget-preview-open (&optional new-session)
  "Open `markdown-xwidget-preview-url' in an xwidget browser.
With prefix arg NEW-SESSION, open a fresh xwidget session."
  (interactive "P")
  (unless (fboundp 'xwidget-webkit-browse-url)
    (user-error "This Emacs was not built with xwidget-webkit support"))
  (let ((source-buffer (current-buffer)))
    (markdown-xwidget-preview-start)
    (xwidget-webkit-browse-url markdown-xwidget-preview-url new-session)
    (run-at-time 0.05 nil #'markdown-xwidget-preview-polish-buffers)
    (run-at-time 0.35 nil #'markdown-xwidget-preview-send-buffer-from source-buffer)
    (run-at-time 0.45 nil #'markdown-xwidget-preview-highlight-from source-buffer)))

(defun markdown-xwidget-preview-open-beside ()
  "Open the preview beside the current Markdown buffer."
  (interactive)
  (let ((source-window (selected-window)))
    (select-window (or (window-in-direction 'right)
                       (split-window-right)))
    (markdown-xwidget-preview-open nil)
    (select-window source-window)))

(defun markdown-xwidget-preview-polish-buffers ()
  "Hide noisy Emacs chrome from Markdown preview xwidget buffers."
  (when markdown-xwidget-preview-hide-webkit-chrome
    (dolist (window (window-list))
      (with-current-buffer (window-buffer window)
        (when (eq major-mode 'xwidget-webkit-mode)
          (setq-local mode-line-format nil)
          (setq-local header-line-format nil)
          (setq-local tab-line-format nil)
          (setq-local cursor-type nil)
          (setq-local markdown-xwidget-preview--preview-buffer t)
          (when (bound-and-true-p hl-line-mode)
            (hl-line-mode -1))
          (set-window-fringes window 0 0)
          (set-window-margins window markdown-xwidget-preview-window-padding markdown-xwidget-preview-window-padding)
          (set-window-scroll-bars window nil nil nil nil)
          (rename-buffer markdown-xwidget-preview-buffer-name t)
          (add-hook 'kill-buffer-hook #'markdown-xwidget-preview--kill-preview-buffer nil t)
          (markdown-xwidget-preview--install-external-link-handler)
          (force-mode-line-update))))))

(defun markdown-xwidget-preview--install-external-link-handler ()
  "Make preview links open in the user's browser instead of xwidget."
  (when-let* ((widget (markdown-xwidget-preview--matching-widget)))
    (xwidget-webkit-execute-script
     widget
     (format
      "(() => {
        if (window.__markdownExternalLinksInstalled) return;
        window.__markdownExternalLinksInstalled = true;
        document.addEventListener('click', (event) => {
          const link = event.target && event.target.closest && event.target.closest('a[href]');
          if (!link) return;
          const href = link.href;
          if (!href || href.startsWith(location.origin)) return;
          event.preventDefault();
          document.title = %s + href;
        }, true);
      })()"
      (json-encode markdown-xwidget-preview--external-title-prefix)))))

(defun markdown-xwidget-preview--maybe-open-external-link (widget)
  "Open external link encoded in WIDGET title, when present."
  (when (and (xwidgetp widget)
             (xwidget-live-p widget)
             (fboundp 'xwidget-webkit-title))
    (when-let* ((title (ignore-errors (xwidget-webkit-title widget))))
      (when (and (stringp title)
                 (string-prefix-p markdown-xwidget-preview--external-title-prefix title))
        (let ((url (string-remove-prefix markdown-xwidget-preview--external-title-prefix title)))
          (xwidget-webkit-execute-script widget "document.title = document.location.href")
          (browse-url url))))))

(defun markdown-xwidget-preview--xwidget-callback-advice (widget _event-type)
  "Handle preview xwidget callback events for WIDGET."
  (markdown-xwidget-preview--maybe-open-external-link widget))

(when (fboundp 'xwidget-webkit-callback)
  (advice-add #'xwidget-webkit-callback
              :after #'markdown-xwidget-preview--xwidget-callback-advice))

(defun markdown-xwidget-preview--matching-widget ()
  "Return a live xwidget whose URI starts with `markdown-xwidget-preview-url'."
  (when (boundp 'xwidget-list)
    (seq-find (lambda (widget)
                (and (xwidgetp widget)
                     (xwidget-live-p widget)
                     (fboundp 'xwidget-webkit-uri)
                     (let ((uri (ignore-errors (xwidget-webkit-uri widget))))
                       (and (stringp uri)
                            (string-prefix-p markdown-xwidget-preview-url uri)))))
              xwidget-list)))

(defun markdown-xwidget-preview-reload ()
  "Reload the Markdown xwidget preview."
  (interactive)
  (let ((source-buffer (current-buffer)))
    (if-let* ((widget (markdown-xwidget-preview--matching-widget)))
        (progn
          (xwidget-webkit-execute-script widget "location.reload()")
          (run-at-time 0.35 nil #'markdown-xwidget-preview-send-buffer-from source-buffer)
          (run-at-time 0.45 nil #'markdown-xwidget-preview-highlight-from source-buffer))
      (markdown-xwidget-preview-open nil))))

(defun markdown-xwidget-preview-send-buffer-from (buffer)
  "Send BUFFER contents to the xwidget preview."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (markdown-xwidget-preview-send-buffer))))

(defun markdown-xwidget-preview-highlight-from (buffer)
  "Highlight BUFFER point in the xwidget preview."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (markdown-xwidget-preview-highlight-current-line))))

(defun markdown-xwidget-preview-send-buffer ()
  "Send current buffer contents to the xwidget preview."
  (interactive)
  (when (and markdown-xwidget-preview-live-edits
             (not (minibufferp)))
    (when-let* ((widget (markdown-xwidget-preview--matching-widget)))
      (xwidget-webkit-execute-script
       widget
       (format "window.updateNoteSource && window.updateNoteSource(%s)"
               (json-encode (buffer-substring-no-properties (point-min) (point-max)))))
      (setq markdown-xwidget-preview--browser-in-sync t))))

(defun markdown-xwidget-preview-send-edit (begin end length)
  "Send the last buffer edit as a splice to the xwidget preview."
  (when (and markdown-xwidget-preview-live-edits
             markdown-xwidget-preview--browser-in-sync
             (not (minibufferp)))
    (when-let* ((widget (markdown-xwidget-preview--matching-widget)))
      (xwidget-webkit-execute-script
       widget
       (format "window.applyNoteEdit && window.applyNoteEdit(%d, %d, %s)"
               (1- begin)
               (+ (1- begin) length)
               (json-encode (buffer-substring-no-properties begin end)))))))

(defun markdown-xwidget-preview--after-change (begin end length)
  "Send a live preview update after a buffer change."
  (if (<= markdown-xwidget-preview-live-edit-delay 0)
      (progn
        (cond
         ((not markdown-xwidget-preview--browser-in-sync)
          (markdown-xwidget-preview-send-buffer))
         ((markdown-xwidget-preview-insert-state-p)
          (markdown-xwidget-preview-send-edit begin end length))
         (t
          (markdown-xwidget-preview-send-buffer)))
        (markdown-xwidget-preview-highlight-current-line))
    (markdown-xwidget-preview--schedule-live-edit)))

(defun markdown-xwidget-preview--schedule-live-edit ()
  "Debounce sending unsaved edits to the preview."
  (when markdown-xwidget-preview--live-edit-timer
    (cancel-timer markdown-xwidget-preview--live-edit-timer))
  (setq markdown-xwidget-preview--live-edit-timer
        (run-with-idle-timer markdown-xwidget-preview-live-edit-delay
                             nil
                             #'markdown-xwidget-preview--flush-live-edit
                             (current-buffer))))

(defun markdown-xwidget-preview--flush-live-edit (buffer)
  "Send BUFFER contents to the preview after an idle delay."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (setq markdown-xwidget-preview--live-edit-timer nil)
      (markdown-xwidget-preview-send-buffer)
      (markdown-xwidget-preview-highlight-current-line))))

(defun markdown-xwidget-preview-source-column ()
  "Return point's source column, ignoring visual hiding/pretty display."
  (- (point) (line-beginning-position)))

(defun markdown-xwidget-preview-insert-state-p ()
  "Return non-nil when Evil is currently inserting text."
  (and (boundp 'evil-state)
       (eq evil-state 'insert)))

(defun markdown-xwidget-preview-visual-state-p ()
  "Return non-nil when Evil is currently selecting text."
  (and (boundp 'evil-state)
       (memq evil-state '(visual vline vblock))))

(defun markdown-xwidget-preview-source-point-at (position)
  "Return source line and column at POSITION."
  (save-excursion
    (goto-char position)
    (cons (line-number-at-pos)
          (- (point) (line-beginning-position)))))

(defun markdown-xwidget-preview-visual-range ()
  "Return selected source range as line/column pairs."
  (let* ((begin (region-beginning))
         (end (region-end))
         (inclusive-end (if (> end begin) (1- end) end)))
    (cons (markdown-xwidget-preview-source-point-at begin)
          (markdown-xwidget-preview-source-point-at inclusive-end))))

(defun markdown-xwidget-preview-after-space-p ()
  "Return non-nil when point is just after source whitespace."
  (and (> (point) (line-beginning-position))
       (save-excursion
         (backward-char 1)
         (looking-at-p "[[:space:]]"))))

(defun markdown-xwidget-preview-preview-column ()
  "Return the source column to show in the preview."
  (+ (markdown-xwidget-preview-source-column)
     (if (and (markdown-xwidget-preview-insert-state-p)
              (not (markdown-xwidget-preview-after-space-p)))
         markdown-xwidget-preview-insert-column-offset
       0)))

(defun markdown-xwidget-preview-show-block-p ()
  "Return non-nil when the preview should show block highlighting."
  t)

(defun markdown-xwidget-preview-show-caret-p ()
  "Return non-nil when the preview should show the caret."
  (markdown-xwidget-preview-insert-state-p))

(defun markdown-xwidget-preview-show-rail-p ()
  "Return non-nil when the preview should show the special-block rail."
  (markdown-xwidget-preview-insert-state-p))

(defun markdown-xwidget-preview-highlight-current-line ()
  "Highlight point or the active visual selection in the xwidget preview."
  (interactive)
  (when markdown-xwidget-preview-highlight-cursor
    (if (and (markdown-xwidget-preview-visual-state-p) (use-region-p))
        (markdown-xwidget-preview-highlight-visual-range)
      (markdown-xwidget-preview-highlight-point))))

(defun markdown-xwidget-preview-highlight-visual-range ()
  "Highlight the active visual selection in the xwidget preview."
  (let* ((range (markdown-xwidget-preview-visual-range))
         (start (car range))
         (end (cdr range))
         (cache-key (list 'range start end)))
    (unless (equal cache-key markdown-xwidget-preview--last-highlighted-position)
      (setq markdown-xwidget-preview--last-highlighted-position cache-key)
      (when-let* ((widget (markdown-xwidget-preview--matching-widget)))
        (xwidget-webkit-execute-script
         widget
         (format "window.highlightSourceRange && window.highlightSourceRange(%d, %d, %d, %d)"
                 (car start)
                 (cdr start)
                 (car end)
                 (cdr end)))))))

(defun markdown-xwidget-preview-highlight-point ()
  "Highlight point in the xwidget preview."
  (let ((line (line-number-at-pos))
        (column (markdown-xwidget-preview-preview-column))
        (show-block (markdown-xwidget-preview-show-block-p))
        (show-caret (markdown-xwidget-preview-show-caret-p))
        (show-rail (markdown-xwidget-preview-show-rail-p)))
    (setq markdown-xwidget-preview--last-highlighted-position
          (list 'point line column show-block show-caret show-rail))
    (when-let* ((widget (markdown-xwidget-preview--matching-widget)))
      (xwidget-webkit-execute-script
       widget
       (format "window.highlightSourcePosition && window.highlightSourcePosition(%d, %d, %s, %s, %s)"
               line
               column
               (if show-block "true" "false")
               (if show-caret "true" "false")
               (if show-rail "true" "false"))))))

(defun markdown-xwidget-preview--after-save ()
  (markdown-xwidget-preview-send-buffer)
  (if markdown-xwidget-preview-reload-on-save
      (progn
        (markdown-xwidget-preview-reload)
        (run-at-time 0.2 nil #'markdown-xwidget-preview-highlight-current-line))
    (run-at-time 0.05 nil #'markdown-xwidget-preview-highlight-current-line)))

(defun markdown-xwidget-preview--kill-preview-buffer ()
  "Stop the preview server and clean artifacts."
  (when markdown-xwidget-preview-kill-server-on-preview-kill
    (markdown-xwidget-preview-stop))
  (when markdown-xwidget-preview-clean-artifacts-on-preview-kill
    (run-at-time 0.8 nil #'markdown-xwidget-preview-clean-artifacts)))

(defun markdown-xwidget-preview--kill-buffer ()
  "Clean up preview resources when the source buffer is killed."
  (when markdown-xwidget-preview--live-edit-timer
    (cancel-timer markdown-xwidget-preview--live-edit-timer)
    (setq markdown-xwidget-preview--live-edit-timer nil))
  (when markdown-xwidget-preview-kill-server-on-buffer-kill
    (markdown-xwidget-preview-stop)))

;;;###autoload
(defun markdown-xwidget-preview-setup (&optional modes)
  "Enable Markdown xwidget preview for MODES.
When MODES is nil, enable it for `markdown-mode' and `gfm-mode'.
Also installs Doom localleader bindings when Doom's `map!' macro is available."
  (interactive)
  (dolist (mode (or modes '(markdown-mode gfm-mode)))
    (add-hook (intern (format "%s-hook" mode)) #'markdown-xwidget-preview-mode))
  (when (fboundp 'map!)
    (eval
     '(map! :after markdown-mode
            :map markdown-mode-map
            :localleader
            "p" #'markdown-xwidget-preview-open-beside
            "r" #'markdown-xwidget-preview-reload
            "R" #'markdown-xwidget-preview-restart
            "s" #'markdown-xwidget-preview-start
            "k" #'markdown-xwidget-preview-stop))))

;;;###autoload
(define-minor-mode markdown-xwidget-preview-mode
  "Minor mode for live Markdown preview through xwidgets."
  :lighter " Markdown↗"
  (if markdown-xwidget-preview-mode
      (progn
        (add-hook 'after-change-functions #'markdown-xwidget-preview--after-change nil t)
        (add-hook 'after-save-hook #'markdown-xwidget-preview--after-save nil t)
        (add-hook 'kill-buffer-hook #'markdown-xwidget-preview--kill-buffer nil t)
        (add-hook 'post-command-hook #'markdown-xwidget-preview-highlight-current-line nil t)
        (markdown-xwidget-preview-send-buffer))
    (remove-hook 'after-change-functions #'markdown-xwidget-preview--after-change t)
    (remove-hook 'after-save-hook #'markdown-xwidget-preview--after-save t)
    (remove-hook 'kill-buffer-hook #'markdown-xwidget-preview--kill-buffer t)
    (remove-hook 'post-command-hook #'markdown-xwidget-preview-highlight-current-line t)
    (when markdown-xwidget-preview--live-edit-timer
      (cancel-timer markdown-xwidget-preview--live-edit-timer)
      (setq markdown-xwidget-preview--live-edit-timer nil))))

(provide 'markdown-xwidget-preview)
;;; markdown-xwidget-preview.el ends here
