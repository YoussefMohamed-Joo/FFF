/**
 * Sandbox Inspect Mode Library
 *
 * This script is injected into iframe pages to enable element inspection.
 * It communicates with the parent window via postMessage.
 *
 * Usage: Include this script in your iframe page
 * <script src="/sandbox_inspect.js"></script>
 */

;(function () {
  'use strict'

  // Prevent multiple initializations
  if (window.__SANDBOX_INSPECT_INITIALIZED__) {
    return
  }
  window.__SANDBOX_INSPECT_INITIALIZED__ = true

  // ============================================
  // Configuration
  // ============================================
  const CONFIG = {
    MESSAGE_PREFIX: 'sandbox-inspect',
    EXCLUDED_TAGS: [
      'html',
      'body',
      'head',
      'script',
      'style',
      'meta',
      'link',
      'title',
    ],
    THROTTLE_DELAY: 16, // ~60fps
  }

  // ============================================
  // State Management
  // ============================================
  const state = {
    enabled: false,
    editMode: false, // Edit mode state
    visualEditMode: false, // Visual edit mode state (inspect + change tracking)
    hoveredElement: null,
    selectedElement: null,
    parentOrigin: '*', // Will be set when receiving first message from parent
    // Drag state
    isDragging: false,
    dragElement: null,
    dragStartX: 0,
    dragStartY: 0,
    dragOffsetX: 0,
    dragOffsetY: 0,
    dropTarget: null,
    dropPosition: null, // 'before', 'after', 'inside'
  }

  // ============================================
  // Edit Mode Configuration
  // ============================================
  const editModeConfig = {
    debounceDelay: 5000, // 5 seconds to merge edits
    minDebounceDelay: 500, // Minimum delay before saving (for rapid typing)
  }

  const editModeState = {
    pendingSnapshot: null, // Snapshot captured before current edit batch
    debounceTimer: null, // Timer for debounced save
    lastEditTime: 0, // Timestamp of last edit
    editCount: 0, // Number of edits in current batch
    isEditing: false, // Currently in an edit batch
  }

  // ============================================
  // History Management
  // ============================================
  const historyConfig = {
    maxHistorySize: 50,
  }

  const historyState = {
    history: [], // Array of snapshots
    currentIndex: -1, // Current position in history
    isRestoring: false, // Flag to prevent capturing during restore
  }

  /**
   * Capture current DOM state as a snapshot
   * @param {string} operationType - Type of operation that triggered the snapshot
   * @param {string} description - Human-readable description
   * @returns {Object} Snapshot object
   */
  function captureSnapshot(operationType = 'manual', description = '') {
    if (historyState.isRestoring) return null

    try {
      const bodyClone = document.body.cloneNode(true)

      // Remove inspector-added elements from the snapshot
      const inspectorElements = bodyClone.querySelectorAll(
        '.__sandbox-drag-ghost__, .__sandbox-drop-indicator__, #__sandbox-edit-mode-styles__, #__sandbox-visual-edit-mode-styles__'
      )
      inspectorElements.forEach(el => el.remove())

      // Remove mode-specific attributes/classes from the clone
      bodyClone.removeAttribute('contenteditable')
      bodyClone.classList.remove('__visual-edit-mode__')

      const snapshot = {
        id: `snapshot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
        htmlContent: bodyClone.innerHTML,
        operationType: operationType,
        description: description || `${operationType} operation`,
        scrollX: window.scrollX || 0,
        scrollY: window.scrollY || 0,
      }

      return snapshot
    } catch (error) {
      console.error('[SandboxInspect] Failed to capture snapshot:', error)
      return null
    }
  }

  /**
   * Add a snapshot to history
   * @param {Object} snapshot - Snapshot to add
   */
  function addSnapshotToHistory(snapshot) {
    if (!snapshot || historyState.isRestoring) return

    // If we're not at the end of history, truncate future states
    if (historyState.currentIndex < historyState.history.length - 1) {
      historyState.history = historyState.history.slice(
        0,
        historyState.currentIndex + 1
      )
    }

    // Compute diff with previous snapshot using diff-dom
    if (historyState.history.length > 0) {
      const prevSnapshot = historyState.history[historyState.history.length - 1]
      snapshot.diff = computeDomDiff(
        prevSnapshot.htmlContent,
        snapshot.htmlContent
      )
    } else {
      snapshot.diff = []
    }

    // Add new snapshot
    historyState.history.push(snapshot)
    historyState.currentIndex = historyState.history.length - 1

    // Limit history size
    if (historyState.history.length > historyConfig.maxHistorySize) {
      const removeCount =
        historyState.history.length - historyConfig.maxHistorySize
      historyState.history.splice(0, removeCount)
      historyState.currentIndex -= removeCount
    }

    // Notify parent of history state change
    sendHistoryState()

    console.log(
      '[SandboxInspect] Snapshot added:',
      snapshot.operationType,
      `(${historyState.currentIndex + 1}/${historyState.history.length})`
    )
  }

  /**
   * Capture and add a snapshot to history
   * @param {string} operationType - Type of operation
   * @param {string} description - Description
   */
  function saveToHistory(operationType, description) {
    const snapshot = captureSnapshot(operationType, description)
    if (snapshot) {
      addSnapshotToHistory(snapshot)
    }
  }

  /**
   * Apply a snapshot to restore DOM state
   * @param {Object} snapshot - Snapshot to apply
   * @returns {boolean} Success status
   */
  function applySnapshot(snapshot) {
    if (!snapshot) return false

    historyState.isRestoring = true

    // Remember edit mode state before restoring
    const wasInEditMode = state.editMode
    const wasInVisualEditMode = state.visualEditMode

    // No observer to pause — snapshot-restore calls input-free DOM writes,
    // which don't trigger our `input` listener. Nothing to do here.

    try {
      // Restore HTML content
      document.body.innerHTML = snapshot.htmlContent

      // Restore scroll position
      window.scrollTo(snapshot.scrollX || 0, snapshot.scrollY || 0)

      // Clear selected element since DOM has changed
      state.selectedElement = null
      state.hoveredElement = null

      // Notify parent about cleared selection
      sendToParent('unselect', { element: null, reason: 'historyRestore' })
      sendToParent('unhover', { element: null, reason: 'historyRestore' })

      // If we were in edit mode, restore contentEditable and styles
      if (wasInEditMode) {
        document.body.contentEditable = 'true'
        // Re-add edit mode styles (they were removed from snapshot)
        addEditModeStyles()
      }
      // If we were in visual edit mode, restore contentEditable and styles
      if (wasInVisualEditMode) {
        document.body.contentEditable = 'true'
        addVisualEditModeStyles()
      }

      console.log('[SandboxInspect] Snapshot applied:', snapshot.operationType)
      return true
    } catch (error) {
      console.error('[SandboxInspect] Failed to apply snapshot:', error)
      return false
    } finally {
      historyState.isRestoring = false
      // Reset edit state regardless of success — otherwise a stale debounce
      // timer could fire later and capture the partially-restored or live
      // DOM (including any AJAX/timer mutations).
      if (wasInEditMode || wasInVisualEditMode) {
        editModeState.isEditing = false
        editModeState.pendingSnapshot = null
        editModeState.editCount = 0
        if (editModeState.debounceTimer) {
          clearTimeout(editModeState.debounceTimer)
          editModeState.debounceTimer = null
        }
        sendToParent('editActivity', {
          editCount: 0,
          pending: false,
        })
      }
    }
  }

  /**
   * Undo - go back in history
   * @returns {boolean} Success status
   */
  function undo() {
    // If in edit/visual edit mode with pending changes, flush them first
    if ((state.editMode || state.visualEditMode) && editModeState.isEditing) {
      flushEditHistory()
    }

    if (!canUndo()) {
      console.log('[SandboxInspect] Cannot undo - at beginning of history')
      return false
    }

    // Get the snapshot being undone (current snapshot) - its diff shows what will be reverted
    const undoneSnapshot = historyState.history[historyState.currentIndex]
    const targetIndex = historyState.currentIndex - 1
    const targetSnapshot = historyState.history[targetIndex]

    if (applySnapshot(targetSnapshot)) {
      historyState.currentIndex = targetIndex
      sendHistoryState()
      // Send the undone snapshot's info so the diff shows what was actually undone
      sendToParent('historyUndo', {
        snapshot: getSnapshotInfo(undoneSnapshot),
        historyInfo: getHistoryInfo(),
      })
      return true
    }
    return false
  }

  /**
   * Redo - go forward in history
   * @returns {boolean} Success status
   */
  function redo() {
    // If in edit/visual edit mode with pending changes, flush them first
    if ((state.editMode || state.visualEditMode) && editModeState.isEditing) {
      flushEditHistory()
    }

    if (!canRedo()) {
      console.log('[SandboxInspect] Cannot redo - at end of history')
      return false
    }

    const targetIndex = historyState.currentIndex + 1
    const targetSnapshot = historyState.history[targetIndex]

    if (applySnapshot(targetSnapshot)) {
      historyState.currentIndex = targetIndex
      sendHistoryState()
      sendToParent('historyRedo', {
        snapshot: getSnapshotInfo(targetSnapshot),
        historyInfo: getHistoryInfo(),
      })
      return true
    }
    return false
  }

  /**
   * Check if undo is possible
   * @returns {boolean}
   */
  function canUndo() {
    return historyState.currentIndex > 0
  }

  /**
   * Check if redo is possible
   * @returns {boolean}
   */
  function canRedo() {
    return historyState.currentIndex < historyState.history.length - 1
  }

  /**
   * Get history information
   * @returns {Object} History info
   */
  function getHistoryInfo() {
    return {
      historySize: historyState.history.length,
      currentIndex: historyState.currentIndex,
      canUndo: canUndo(),
      canRedo: canRedo(),
    }
  }

  // diff-dom loading state
  let diffDomLoaded = false
  let diffDomLoading = false
  let diffDomLoadCallbacks = []

  /**
   * Load diff-dom library from CDN
   * @returns {Promise<boolean>} Whether loading was successful
   */
  function loadDiffDom() {
    return new Promise(resolve => {
      if (diffDomLoaded && window.diffDOM) {
        resolve(true)
        return
      }

      if (diffDomLoading) {
        diffDomLoadCallbacks.push(resolve)
        return
      }

      diffDomLoading = true

      const script = document.createElement('script')
      // Use the browser build which exposes window.diffDOM global
      script.src =
        'https://cdn.jsdelivr.net/npm/diff-dom@5.2.1/browser/diffDOM.js'

      script.onload = () => {
        diffDomLoaded = true
        diffDomLoading = false
        console.log('[SandboxInspect] diff-dom loaded successfully')
        resolve(true)
        diffDomLoadCallbacks.forEach(cb => cb(true))
        diffDomLoadCallbacks = []
      }

      script.onerror = () => {
        diffDomLoading = false
        console.error('[SandboxInspect] Failed to load diff-dom')
        resolve(false)
        diffDomLoadCallbacks.forEach(cb => cb(false))
        diffDomLoadCallbacks = []
      }

      document.head.appendChild(script)
    })
  }

  /**
   * Convert a route array to CSS path by traversing the DOM
   * diff-dom uses childNodes indices (includes text nodes), not children indices
   * @param {Element} container - The container element to traverse from
   * @param {Array<number>} route - Array of childNodes indices representing the path
   * @returns {string|null} CSS selector path from body
   */
  function routeToCssPath(container, route) {
    if (!container || !route || route.length === 0) {
      return null
    }

    try {
      let current = container
      const pathParts = []

      for (const index of route) {
        // diff-dom uses childNodes (includes text nodes), not children
        if (!current.childNodes || index >= current.childNodes.length) {
          // Route is invalid or element doesn't exist
          return null
        }

        const node = current.childNodes[index]

        // Skip non-element nodes (text nodes, comments, etc.) — they have no
        // CSS selector. Return the parent path with a marker that identifies
        // which kind of non-element leaf we were pointing at.
        if (node.nodeType !== 1) {
          const marker = node.nodeType === 8 ? '[comment]' : '[text]'
          if (pathParts.length > 0) {
            return pathParts.join(' > ') + ' > ' + marker
          }
          return marker
        }

        current = node

        // Build selector for this element
        let selector = current.tagName.toLowerCase()

        // Add id if available (makes it unique)
        if (current.id) {
          selector = `#${CSS.escape(current.id)}`
          pathParts.length = 0 // Clear previous parts, id is unique
          pathParts.push(selector)
          continue
        }

        // Add classes (limited to 3)
        if (current.className && typeof current.className === 'string') {
          const classes = current.className
            .split(/\s+/)
            .filter(c => c && !c.startsWith('__'))
            .slice(0, 3)
          if (classes.length > 0) {
            selector += '.' + classes.map(c => CSS.escape(c)).join('.')
          }
        }

        // Add nth-child for uniqueness (based on element siblings only)
        if (current.parentNode) {
          const siblings = current.parentNode.children
          const nthChild = Array.from(siblings).indexOf(current) + 1
          if (nthChild > 0) {
            selector += `:nth-child(${nthChild})`
          }
        }

        pathParts.push(selector)
      }

      return pathParts.length > 0 ? pathParts.join(' > ') : null
    } catch (e) {
      console.error('[SandboxInspect] routeToCssPath failed:', e)
      return null
    }
  }

  /**
   * Compute DOM diff between two HTML strings using diff-dom library
   * Returns diff-dom result array with added cssPath for each diff item
   * @param {string} oldHtml - Previous HTML content
   * @param {string} newHtml - New HTML content
   * @returns {Array} Diff-dom result array with cssPath added
   */
  function computeDomDiff(oldHtml, newHtml) {
    if (!oldHtml || !newHtml) {
      return []
    }

    if (oldHtml === newHtml) {
      return []
    }

    // Use diff-dom library if available
    if (window.diffDOM && window.diffDOM.DiffDOM) {
      try {
        const dd = new window.diffDOM.DiffDOM()

        // Create temporary elements to parse HTML
        const oldContainer = document.createElement('div')
        const newContainer = document.createElement('div')
        oldContainer.innerHTML = oldHtml
        newContainer.innerHTML = newHtml

        // Compute diff
        const diff = dd.diff(oldContainer, newContainer)

        if (!diff || diff.length === 0) {
          return []
        }

        // Add cssPath and HTML content to each diff item
        const enhancedDiff = diff.map(item => {
          const enhanced = { ...item }

          // Convert route to cssPath
          // For most actions, route points to the target element in the old DOM.
          // For 'addElement'/'addTextElement', route points to the new child's
          // position, which only exists in the new DOM.
          if (item.route && Array.isArray(item.route)) {
            const container =
              item.action === 'addElement' || item.action === 'addTextElement'
                ? newContainer
                : oldContainer
            enhanced.cssPath = routeToCssPath(container, item.route)
          }

          // Serialize virtual DOM nodes to HTML for the AI
          const serializeNode = node => {
            try {
              const html = dd.objToNode(node, false).outerHTML
              return html && html.length > 500
                ? html.slice(0, 500) + '...'
                : html || ''
            } catch {
              return ''
            }
          }

          if (
            (item.action === 'addElement' || item.action === 'removeElement') &&
            item.element
          ) {
            enhanced.html = serializeNode(item.element)
          }

          if (item.action === 'replaceElement') {
            if (item.oldValue) enhanced.oldHtml = serializeNode(item.oldValue)
            if (item.newValue) enhanced.newHtml = serializeNode(item.newValue)
          }

          return enhanced
        })

        return enhancedDiff
      } catch (e) {
        console.error('[SandboxInspect] diff-dom failed:', e)
        return []
      }
    }

    // Fallback: return empty array when diff-dom is not loaded
    return []
  }

  /**
   * Get snapshot info (without full HTML content)
   * @param {Object} snapshot - Snapshot
   * @returns {Object} Snapshot info
   */
  function getSnapshotInfo(snapshot) {
    if (!snapshot) return null
    return {
      id: snapshot.id,
      timestamp: snapshot.timestamp,
      operationType: snapshot.operationType,
      description: snapshot.description,
      diff: snapshot.diff || null,
    }
  }

  /**
   * Send history state to parent
   */
  function sendHistoryState() {
    sendToParent('historyState', getHistoryInfo())
  }

  /**
   * Clear history
   */
  function clearHistory() {
    historyState.history = []
    historyState.currentIndex = -1
    sendHistoryState()
    console.log('[SandboxInspect] History cleared')
  }

  /**
   * Get diff between initial state and the latest user-edit state using diff-dom.
   *
   * IMPORTANT: We do NOT compare against the LIVE DOM here — scripts on the
   * page (AJAX responses, setInterval timers, framework re-renders) continue
   * to mutate the live DOM while the user is editing, and including those
   * mutations would pollute the diff with content the user never touched.
   *
   * Instead, we compare history[0] (captured at Edit press) against the most
   * recent history entry, which is only advanced by user-initiated actions:
   * toolbar operations (executeWithHistory → saveToHistory) and typing
   * (`input` event → flushEditHistory).
   *
   * Any pending typing that hasn't been flushed yet is flushed first so the
   * last snapshot is up-to-date.
   */
  function getDiffFromInitial() {
    // Flush any pending user typing so the tail of history is current.
    if (state.editMode || state.visualEditMode) {
      flushEditHistory()
    }

    let initialSnapshot = null
    let latestSnapshot = null

    if (historyState.history.length >= 1) {
      initialSnapshot = historyState.history[0]
      // Use currentIndex (not length - 1) so undo/redo is respected.
      // After an undo, future entries are retained in the array until a new
      // edit truncates them, so length - 1 would point to an undone state
      // that no longer matches the visible DOM.
      latestSnapshot =
        historyState.history[historyState.currentIndex] ||
        historyState.history[historyState.history.length - 1]
    } else if (
      (state.editMode || state.visualEditMode) &&
      editModeState.pendingSnapshot
    ) {
      initialSnapshot = editModeState.pendingSnapshot
      latestSnapshot = editModeState.pendingSnapshot
    }

    if (!initialSnapshot || !latestSnapshot) {
      sendToParent('diffFromInitial', {
        diff: null,
        error: 'No initial state available',
      })
      return
    }

    // Use diff-dom for DOM-level diff (initial vs latest user-edit snapshot)
    const diff = computeDomDiff(
      initialSnapshot.htmlContent,
      latestSnapshot.htmlContent
    )

    sendToParent('diffFromInitial', {
      diff: diff,
      initialSnapshot: getSnapshotInfo(initialSnapshot),
      historyInfo: getHistoryInfo(),
      hasPendingEdits: editModeState.isEditing,
    })
  }

  /**
   * Capture initial state
   */
  function captureInitialState() {
    if (historyState.history.length === 0) {
      saveToHistory('initial', 'Initial state')
    }
  }

  // ============================================
  // Utility Functions
  // ============================================

  /**
   * Simple throttle function
   */
  function throttle(func, delay) {
    let lastCall = 0
    let timeoutId = null

    const throttled = function (...args) {
      const now = Date.now()
      const remaining = delay - (now - lastCall)

      if (remaining <= 0) {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        lastCall = now
        func.apply(this, args)
      } else if (!timeoutId) {
        timeoutId = setTimeout(() => {
          lastCall = Date.now()
          timeoutId = null
          func.apply(this, args)
        }, remaining)
      }
    }

    throttled.cancel = function () {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    return throttled
  }

  /**
   * Check if element should be excluded from inspection
   */
  function isExcludedElement(element) {
    if (!element || element.nodeType !== 1) return true
    const tagName = element.tagName.toLowerCase()
    return CONFIG.EXCLUDED_TAGS.includes(tagName)
  }

  /**
   * Get element's bounding rect relative to viewport
   */
  function getElementRect(element) {
    if (!element) return null

    const rect = element.getBoundingClientRect()
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    }
  }

  /**
   * Get detailed CSS path for an element
   */
  function getCssPath(element, options = {}) {
    const defaults = {
      useIds: true,
      useClasses: true,
      useNthChild: true,
      maxClasses: 3,
    }
    const settings = { ...defaults, ...options }

    if (!element || element.nodeType !== 1) return null

    const path = []
    let current = element

    while (current && current.nodeType === 1) {
      let selector = current.tagName.toLowerCase()

      // Use ID if available
      if (settings.useIds && current.id) {
        selector = `#${CSS.escape(current.id)}`
        path.unshift(selector)
        break
      }

      // Add classes
      if (
        settings.useClasses &&
        current.className &&
        typeof current.className === 'string'
      ) {
        const classes = current.className
          .split(/\s+/)
          .filter(c => c && !c.startsWith('__'))
          .slice(0, settings.maxClasses)

        if (classes.length > 0) {
          selector += '.' + classes.map(c => CSS.escape(c)).join('.')
        }
      }

      // Add nth-child for uniqueness
      if (settings.useNthChild && current.parentNode) {
        const index =
          Array.from(current.parentNode.children).indexOf(current) + 1
        selector += `:nth-child(${index})`
      }

      path.unshift(selector)
      current = current.parentNode

      // Stop at body
      if (
        current &&
        current.tagName &&
        current.tagName.toLowerCase() === 'body'
      ) {
        break
      }
    }

    return path.join(' > ')
  }

  /**
   * Get element info for sending to parent
   * Note: All returned data must be JSON-serializable (no DOM objects)
   */
  function getElementInfo(element) {
    if (!element) return null

    const rect = getElementRect(element)
    if (!rect) return null

    // Ensure className is a string (SVG elements have SVGAnimatedString)
    let className = element.className
    if (className && typeof className !== 'string') {
      className = className.baseVal || String(className)
    }

    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || null,
      className: className || null,
      rect: rect,
      cssPath: getCssPath(element),
      textContent: element.textContent
        ? element.textContent.slice(0, 100).trim()
        : null,
      attributes: getElementAttributes(element),
      outerHTML: null, // Will be populated only for select events
    }
  }

  /**
   * Get key attributes of an element
   */
  function getElementAttributes(element) {
    const attrs = {}
    const importantAttrs = [
      'href',
      'src',
      'alt',
      'title',
      'type',
      'name',
      'value',
      'placeholder',
    ]

    for (const attr of importantAttrs) {
      if (element.hasAttribute(attr)) {
        attrs[attr] = element.getAttribute(attr)
      }
    }

    return attrs
  }

  /**
   * Find meaningful parent element (for Alt+Click)
   */
  function findMeaningfulParent(element) {
    if (!element || !element.parentElement) return null

    const tagName = element.tagName.toLowerCase()

    // Table elements -> select table
    if (['td', 'th', 'tr', 'tbody', 'thead', 'tfoot'].includes(tagName)) {
      const table = element.closest('table')
      if (table) return table
    }

    // List items -> select list
    if (tagName === 'li') {
      const list = element.closest('ul, ol')
      if (list) return list
    }

    // Find nearest block container
    const blockTags = [
      'div',
      'section',
      'article',
      'aside',
      'header',
      'footer',
      'main',
      'figure',
      'blockquote',
      'table',
      'ul',
      'ol',
      'form',
      'nav',
    ]

    let parent = element.parentElement
    while (parent && parent !== document.body) {
      if (blockTags.includes(parent.tagName.toLowerCase())) {
        return parent
      }
      parent = parent.parentElement
    }

    return null
  }

  // ============================================
  // PostMessage Communication
  // ============================================

  /**
   * Send message to parent window
   */
  function sendToParent(type, data = {}) {
    if (!window.parent || window.parent === window) return

    const message = {
      source: CONFIG.MESSAGE_PREFIX,
      type: type,
      data: data,
      timestamp: Date.now(),
    }

    try {
      window.parent.postMessage(message, state.parentOrigin)
    } catch (e) {
      console.error('[SandboxInspect] Failed to send message to parent:', e)
    }
  }

  /**
   * Handle messages from parent window
   */
  function handleParentMessage(event) {
    const message = event.data

    // Validate message format
    if (!message || message.source !== CONFIG.MESSAGE_PREFIX) return

    // Store parent origin for security
    if (state.parentOrigin === '*' && event.origin) {
      state.parentOrigin = event.origin
    }

    switch (message.type) {
      case 'enable':
        enableInspectMode()
        break
      case 'disable':
        disableInspectMode()
        break
      case 'clear':
        clearAllStates()
        break
      case 'getState':
        sendCurrentState()
        break
      case 'ping':
        sendToParent('pong', {
          ready: true,
          url: window.location.href,
          title: document.title,
          historyInfo: getHistoryInfo(),
        })
        break
      // History commands
      case 'undo':
        undo()
        break
      case 'redo':
        redo()
        break
      case 'getHistoryState':
        sendHistoryState()
        break
      case 'clearHistory':
        clearHistory()
        break
      case 'getDiffFromInitial':
        getDiffFromInitial()
        break
      // Edit mode commands
      case 'enableEditMode':
        enableEditMode()
        break
      case 'disableEditMode':
        disableEditMode()
        break
      case 'flushEditHistory':
        flushEditHistory()
        break
      // Visual edit mode commands
      case 'enableVisualEditMode':
        enableVisualEditMode()
        break
      case 'disableVisualEditMode':
        disableVisualEditMode()
        break
      case 'applyStyle':
        applyStylesToSelectedElement(message.data?.styles)
        break
      case 'getElementStyles':
        sendSelectedElementStyles()
        break
      case 'resendElementInfo':
        resendSelectedElementInfo()
        break
      case 'execCommand': {
        const cmd = message.data?.command
        const val = message.data?.value
        if (cmd === 'insertOrderedList') {
          toggleList('OL')
        } else if (cmd === 'insertUnorderedList') {
          toggleList('UL')
        } else if (cmd === 'createLink') {
          createLinkAtSelection(val)
        } else {
          // Fallback for any other command — wrap in history
          executeWithHistory(cmd, () => {
            document.execCommand(cmd, false, val || null)
          })
        }
        break
      }
      case 'insertHtml':
        insertHtmlAtCursor(message.data?.html)
        break
      default:
        console.warn('[SandboxInspect] Unknown message type:', message.type)
    }
  }

  // ============================================
  // Direct DOM editing operations (no execCommand)
  // Each operation: disconnect observer → snapshot before → mutate DOM → snapshot after → reconnect
  // ============================================

  /**
   * Run a DOM mutation wrapped in history snapshots.
   * Temporarily disconnects the MutationObserver so the change is recorded
   * as a single atomic history entry instead of a debounced edit batch.
   */
  function executeWithHistory(description, mutationFn) {
    if (!state.visualEditMode && !state.editMode) return

    // Flush any pending edits so the current state is the latest history entry.
    // No need for a separate "before" snapshot — flushEditHistory ensures
    // history already contains the pre-mutation state.
    flushEditHistory()

    // mutationFn may call document.execCommand which fires `input` events
    // that our listener treats as user typing → sends `editActivity
    // { pending: true }` to parent. Track whether that happened so we can
    // clear parent's pending state in `finally` alongside the local state.
    const hadPendingBefore = editModeState.isEditing
    try {
      // Execute the DOM mutation
      mutationFn()

      // Snapshot the result — single entry, single undo step
      saveToHistory('operation', description)
    } catch (e) {
      console.warn('[SandboxInspect] DOM operation failed:', description, e)
    } finally {
      // mutationFn may fire `input` events (e.g. document.execCommand) that
      // our listener picked up and queued as a pending user-edit batch. Clear
      // that pending state so the debounce doesn't fire a redundant (and
      // AJAX-polluted) snapshot later. Must run even if mutationFn threw,
      // otherwise a stale debounce timer fires ~5s later and captures the
      // live DOM.
      const hadPendingNow = editModeState.isEditing
      editModeState.isEditing = false
      editModeState.pendingSnapshot = null
      editModeState.editCount = 0
      if (editModeState.debounceTimer) {
        clearTimeout(editModeState.debounceTimer)
        editModeState.debounceTimer = null
      }
      // If `input` events from mutationFn flipped isEditing on, we've also
      // sent `pending: true` to parent — clear it so parent's floating bar
      // doesn't stay stuck in the "pending" state.
      if (hadPendingNow && !hadPendingBefore) {
        sendToParent('editActivity', {
          editCount: 0,
          pending: false,
        })
      }
    }
  }

  /**
   * Get the current selection range, or null
   */
  function getSelectionRange() {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    return sel.getRangeAt(0)
  }

  /**
   * Toggle ordered/unordered list around the current selection.
   * If the selection is already inside the target list type, unwrap it.
   */
  function toggleList(listTag) {
    // listTag: 'OL' or 'UL'
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return

    executeWithHistory('Toggle ' + listTag.toLowerCase() + ' list', () => {
      const range = sel.getRangeAt(0)
      let container = range.commonAncestorContainer
      if (container.nodeType === Node.TEXT_NODE)
        container = container.parentElement

      // Check if already inside the target list
      const existingList = container.closest(listTag)
      if (existingList) {
        // Unwrap: replace list with its text content as paragraphs
        const fragment = document.createDocumentFragment()
        for (const li of Array.from(existingList.children)) {
          const p = document.createElement('p')
          p.innerHTML = li.innerHTML
          fragment.appendChild(p)
        }
        existingList.parentNode.replaceChild(fragment, existingList)
      } else {
        // Check if inside the OTHER list type and convert
        const otherTag = listTag === 'OL' ? 'UL' : 'OL'
        const otherList = container.closest(otherTag)
        if (otherList) {
          const newList = document.createElement(listTag)
          newList.innerHTML = otherList.innerHTML
          otherList.parentNode.replaceChild(newList, otherList)
        } else {
          // Wrap selection in a new list
          const list = document.createElement(listTag)
          const li = document.createElement('li')

          if (range.collapsed) {
            // No selection — wrap the parent block
            const block =
              container.closest('p, div, h1, h2, h3, h4, h5, h6') || container
            if (block && block !== document.body) {
              li.innerHTML = block.innerHTML
              list.appendChild(li)
              block.parentNode.replaceChild(list, block)
            }
          } else {
            li.appendChild(range.extractContents())
            list.appendChild(li)
            range.insertNode(list)
          }
        }
      }
    })
  }

  /**
   * Wrap the current selection in an <a> tag
   */
  function createLinkAtSelection(url) {
    if (!url) return

    executeWithHistory('Create link', () => {
      const range = getSelectionRange()
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'

      if (range && !range.collapsed) {
        // Wrap selected text in the link
        a.appendChild(range.extractContents())
        range.insertNode(a)
      } else {
        // No selection (iframe lost focus) — insert link on or inside the selected element
        a.textContent = url
        const target = state.selectedElement || document.body
        target.insertAdjacentElement('beforeend', a)
      }
    })
  }

  /**
   * Insert an HTML fragment at the current cursor position
   */
  function insertHtmlAtCursor(html) {
    if (!html) return

    executeWithHistory('Insert HTML', () => {
      const range = getSelectionRange()
      if (range) {
        const template = document.createElement('template')
        template.innerHTML = html.trim()
        range.deleteContents()
        range.insertNode(template.content)
      } else {
        // No cursor in iframe (focus lost to parent toolbar).
        // Insert inside or after the last selected element.
        const target = state.selectedElement || document.body
        target.insertAdjacentHTML('beforeend', html)
      }
    })
  }

  function sendCurrentState() {
    sendToParent('state', {
      enabled: state.enabled,
      editMode: state.editMode,
      visualEditMode: state.visualEditMode,
      hoveredElement: getElementInfo(state.hoveredElement),
      selectedElement: getElementInfo(state.selectedElement),
    })
  }

  // ============================================
  // Event Handlers
  // ============================================

  /**
   * Handle mouse over event
   */
  function handleMouseOver(event) {
    if (!state.enabled && !state.visualEditMode) return

    const element = event.target
    if (isExcludedElement(element)) return

    // Don't update if same element
    if (state.hoveredElement === element) return

    state.hoveredElement = element

    sendToParent('hover', {
      element: getElementInfo(element),
    })

    event.stopPropagation()
  }

  /**
   * Handle mouse out event
   */
  function handleMouseOut(event) {
    if (!state.enabled && !state.visualEditMode) return

    const element = event.target
    if (isExcludedElement(element)) return

    // Only clear if leaving the hovered element
    if (state.hoveredElement === element) {
      state.hoveredElement = null

      sendToParent('unhover', {
        element: null,
      })
    }

    event.stopPropagation()
  }

  /**
   * Handle click event
   */
  function handleClick(event) {
    // Only active during inspect mode (not visual edit — that uses handleVisualEditMouseUp)
    if (!state.enabled) return

    // Prevent default click behavior (links, buttons, etc.)
    event.preventDefault()
    event.stopPropagation()

    let element = event.target
    if (isExcludedElement(element)) return

    // Alt+Click: select parent container
    if (event.altKey) {
      const parent = findMeaningfulParent(element)
      if (parent) {
        element = parent
      }
    }

    // Toggle selection if clicking same element
    if (state.selectedElement === element) {
      state.selectedElement = null
      sendToParent('unselect', {
        element: null,
      })
    } else {
      state.selectedElement = element
      const elementInfo = getElementInfo(element)
      // Add outerHTML for select events only, limited to 1000 characters
      if (elementInfo && element.outerHTML) {
        const html = element.outerHTML
        elementInfo.outerHTML =
          html.length > 1000 ? html.slice(0, 1000) + '...' : html
      }
      // handleClick is only active in inspect mode (not visual edit),
      // so no need to include computed styles here
      sendToParent('select', { element: elementInfo })
    }
  }

  /**
   * Handle mousedown event for drag initiation
   */
  function handleMouseDown(event) {
    // Only registered during inspect mode (enableInspectMode), not visual edit
    if (!state.enabled || !state.selectedElement) return

    // Only start drag if clicking on the selected element
    if (
      !state.selectedElement.contains(event.target) &&
      state.selectedElement !== event.target
    ) {
      return
    }

    // Shift+Click to start dragging
    if (!event.shiftKey) return

    event.preventDefault()
    event.stopPropagation()

    state.isDragging = true
    state.dragElement = state.selectedElement
    state.dragStartX = event.clientX
    state.dragStartY = event.clientY

    const rect = state.dragElement.getBoundingClientRect()
    state.dragOffsetX = event.clientX - rect.left
    state.dragOffsetY = event.clientY - rect.top

    // Add dragging visual style
    state.dragElement.style.opacity = '0.5'
    state.dragElement.style.pointerEvents = 'none'
    document.body.style.cursor = 'grabbing'

    // Create drag ghost element
    createDragGhost(state.dragElement, event.clientX, event.clientY)

    sendToParent('dragStart', {
      element: getElementInfo(state.dragElement),
      startX: event.clientX,
      startY: event.clientY,
    })

    console.log('[SandboxInspect] Drag started')
  }

  /**
   * Handle mousemove event for dragging
   */
  function handleDragMove(event) {
    if (!state.isDragging || !state.dragElement) return

    event.preventDefault()
    event.stopPropagation()

    // Update ghost position
    updateDragGhost(event.clientX, event.clientY)

    // Find drop target
    const elementsAtPoint = document.elementsFromPoint(
      event.clientX,
      event.clientY
    )
    let dropTarget = null
    let dropPosition = null

    for (const elem of elementsAtPoint) {
      // Skip the drag element, ghost, and excluded elements
      if (
        elem === state.dragElement ||
        elem.classList.contains('__sandbox-drag-ghost__') ||
        elem.classList.contains('__sandbox-drop-indicator__') ||
        isExcludedElement(elem) ||
        state.dragElement.contains(elem)
      ) {
        continue
      }
      dropTarget = elem
      break
    }

    if (dropTarget) {
      const targetRect = dropTarget.getBoundingClientRect()
      const relativeY = event.clientY - targetRect.top
      const targetHeight = targetRect.height

      // Determine drop position based on mouse position within target
      if (relativeY < targetHeight * 0.25) {
        dropPosition = 'before'
      } else if (relativeY > targetHeight * 0.75) {
        dropPosition = 'after'
      } else {
        dropPosition = 'inside'
      }

      // Update drop indicator
      updateDropIndicator(dropTarget, dropPosition)

      if (
        state.dropTarget !== dropTarget ||
        state.dropPosition !== dropPosition
      ) {
        state.dropTarget = dropTarget
        state.dropPosition = dropPosition

        sendToParent('dragOver', {
          dragElement: getElementInfo(state.dragElement),
          dropTarget: getElementInfo(dropTarget),
          dropPosition: dropPosition,
          clientX: event.clientX,
          clientY: event.clientY,
        })
      }
    } else {
      removeDropIndicator()
      state.dropTarget = null
      state.dropPosition = null
    }
  }

  /**
   * Handle mouseup event for drop
   */
  function handleMouseUp(event) {
    if (!state.isDragging || !state.dragElement) return

    event.preventDefault()
    event.stopPropagation()

    const dragElement = state.dragElement
    const dropTarget = state.dropTarget
    const dropPosition = state.dropPosition

    // Get element info before moving
    const dragElementInfo = getElementInfo(dragElement)
    const dropTargetInfo = dropTarget ? getElementInfo(dropTarget) : null

    // Calculate movement delta
    const deltaX = event.clientX - state.dragStartX
    const deltaY = event.clientY - state.dragStartY

    // Restore element style
    dragElement.style.opacity = ''
    dragElement.style.pointerEvents = ''
    document.body.style.cursor = ''

    // Remove visual elements
    removeDragGhost()
    removeDropIndicator()

    // Perform the actual DOM move if there's a valid drop target
    let moveSuccess = false
    let newPosition = null

    if (dropTarget && dropPosition) {
      try {
        // Capture state before the move (but don't add to history yet)
        const beforeSnapshot = captureSnapshot(
          'beforeMove',
          `Before moving ${dragElement.tagName.toLowerCase()}`
        )

        if (dropPosition === 'before') {
          dropTarget.parentElement.insertBefore(dragElement, dropTarget)
        } else if (dropPosition === 'after') {
          dropTarget.parentElement.insertBefore(
            dragElement,
            dropTarget.nextSibling
          )
        } else if (dropPosition === 'inside') {
          dropTarget.appendChild(dragElement)
        }

        // DOM operation succeeded - now save history
        moveSuccess = true
        newPosition = {
          parent: getElementInfo(dragElement.parentElement),
          index: Array.from(dragElement.parentElement.children).indexOf(
            dragElement
          ),
        }

        // Add beforeMove snapshot to history (only if DOM operation succeeded)
        if (beforeSnapshot) {
          addSnapshotToHistory(beforeSnapshot)
        }

        // Save state after the move
        saveToHistory(
          'move',
          `Moved ${dragElement.tagName.toLowerCase()} ${dropPosition} ${dropTarget.tagName.toLowerCase()}`
        )

        console.log('[SandboxInspect] Element moved:', dropPosition, 'target')
      } catch (e) {
        console.error('[SandboxInspect] Failed to move element:', e)
        moveSuccess = false
      }
    }

    // Send drag end event with all information
    sendToParent('dragEnd', {
      element: dragElementInfo,
      dropTarget: dropTargetInfo,
      dropPosition: dropPosition,
      deltaX: deltaX,
      deltaY: deltaY,
      moveSuccess: moveSuccess,
      newPosition: newPosition,
      finalRect: getElementRect(dragElement),
    })

    // Update selected element info after move
    if (moveSuccess) {
      const updatedElementInfo = getElementInfo(dragElement)
      if (updatedElementInfo && dragElement.outerHTML) {
        const html = dragElement.outerHTML
        updatedElementInfo.outerHTML =
          html.length > 1000 ? html.slice(0, 1000) + '...' : html
      }
      sendToParent('select', {
        element: updatedElementInfo,
      })
    }

    // Reset drag state
    state.isDragging = false
    state.dragElement = null
    state.dragStartX = 0
    state.dragStartY = 0
    state.dragOffsetX = 0
    state.dragOffsetY = 0
    state.dropTarget = null
    state.dropPosition = null

    console.log('[SandboxInspect] Drag ended')
  }

  /**
   * Create a ghost element for drag visualization
   */
  function createDragGhost(element, x, y) {
    removeDragGhost() // Remove any existing ghost

    const ghost = document.createElement('div')
    ghost.className = '__sandbox-drag-ghost__'

    const rect = element.getBoundingClientRect()
    ghost.style.cssText = `
      position: fixed;
      left: ${x - state.dragOffsetX}px;
      top: ${y - state.dragOffsetY}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      background: rgba(59, 130, 246, 0.2);
      border: 2px dashed #3b82f6;
      border-radius: 4px;
      pointer-events: none;
      z-index: 10000;
      transition: none;
    `

    document.body.appendChild(ghost)
  }

  /**
   * Update ghost element position
   */
  function updateDragGhost(x, y) {
    const ghost = document.querySelector('.__sandbox-drag-ghost__')
    if (ghost) {
      ghost.style.left = `${x - state.dragOffsetX}px`
      ghost.style.top = `${y - state.dragOffsetY}px`
    }
  }

  /**
   * Remove drag ghost element
   */
  function removeDragGhost() {
    const ghost = document.querySelector('.__sandbox-drag-ghost__')
    if (ghost) {
      ghost.remove()
    }
  }

  /**
   * Update drop indicator
   */
  function updateDropIndicator(target, position) {
    let indicator = document.querySelector('.__sandbox-drop-indicator__')

    if (!indicator) {
      indicator = document.createElement('div')
      indicator.className = '__sandbox-drop-indicator__'
      indicator.style.cssText = `
        position: fixed;
        pointer-events: none;
        z-index: 10001;
        transition: all 0.1s ease;
      `
      document.body.appendChild(indicator)
    }

    const targetRect = target.getBoundingClientRect()

    if (position === 'before') {
      indicator.style.left = `${targetRect.left}px`
      indicator.style.top = `${targetRect.top - 2}px`
      indicator.style.width = `${targetRect.width}px`
      indicator.style.height = '4px'
      indicator.style.background = '#10b981'
      indicator.style.border = 'none'
      indicator.style.borderRadius = '2px'
    } else if (position === 'after') {
      indicator.style.left = `${targetRect.left}px`
      indicator.style.top = `${targetRect.bottom - 2}px`
      indicator.style.width = `${targetRect.width}px`
      indicator.style.height = '4px'
      indicator.style.background = '#10b981'
      indicator.style.border = 'none'
      indicator.style.borderRadius = '2px'
    } else if (position === 'inside') {
      indicator.style.left = `${targetRect.left}px`
      indicator.style.top = `${targetRect.top}px`
      indicator.style.width = `${targetRect.width}px`
      indicator.style.height = `${targetRect.height}px`
      indicator.style.background = 'rgba(16, 185, 129, 0.1)'
      indicator.style.border = '2px solid #10b981'
      indicator.style.borderRadius = '4px'
    }
  }

  /**
   * Remove drop indicator
   */
  function removeDropIndicator() {
    const indicator = document.querySelector('.__sandbox-drop-indicator__')
    if (indicator) {
      indicator.remove()
    }
  }

  /**
   * Handle scroll event (throttled)
   */
  const handleScroll = throttle(function () {
    if (!state.enabled && !state.visualEditMode) return

    const updates = {}

    if (state.hoveredElement) {
      updates.hoveredElement = getElementInfo(state.hoveredElement)
    }

    if (state.selectedElement) {
      // Check if element is still in DOM
      if (!document.contains(state.selectedElement)) {
        state.selectedElement = null
        updates.selectedElement = null
      } else {
        updates.selectedElement = getElementInfo(state.selectedElement)
      }
    }

    sendToParent('positionUpdate', updates)
  }, CONFIG.THROTTLE_DELAY)

  /**
   * Handle resize event (throttled)
   */
  const handleResize = throttle(function () {
    if (!state.enabled && !state.visualEditMode) return

    const updates = {}

    if (state.hoveredElement) {
      updates.hoveredElement = getElementInfo(state.hoveredElement)
    }

    if (state.selectedElement) {
      if (!document.contains(state.selectedElement)) {
        state.selectedElement = null
        updates.selectedElement = null
      } else {
        updates.selectedElement = getElementInfo(state.selectedElement)
      }
    }

    sendToParent('positionUpdate', updates)
  }, CONFIG.THROTTLE_DELAY)

  /**
   * Use MutationObserver to detect DOM changes
   */
  let mutationObserver = null

  function setupMutationObserver() {
    if (mutationObserver) return

    mutationObserver = new MutationObserver(
      throttle(function (mutations) {
        if (!state.enabled) return

        // Check if selected element was removed
        if (
          state.selectedElement &&
          !document.contains(state.selectedElement)
        ) {
          state.selectedElement = null
          sendToParent('unselect', { element: null, reason: 'removed' })
        }

        // Check if hovered element was removed
        if (state.hoveredElement && !document.contains(state.hoveredElement)) {
          state.hoveredElement = null
          sendToParent('unhover', { element: null, reason: 'removed' })
        }

        // Send position update if elements still exist
        if (state.selectedElement || state.hoveredElement) {
          handleScroll()
        }
      }, 100)
    )

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
  }

  function teardownMutationObserver() {
    if (mutationObserver) {
      mutationObserver.disconnect()
      mutationObserver = null
    }
  }

  // ============================================
  // Edit Mode Control
  // ============================================

  /**
   * Handle input event in edit mode (debounced history save)
   */
  function handleEditInput() {
    if (!state.editMode && !state.visualEditMode) return

    const now = Date.now()

    // If this is the start of a new edit batch, reference the "before" state
    // Note: We use the last history entry instead of capturing a new snapshot
    // because MutationObserver fires AFTER the DOM mutation, so capturing now
    // would get the post-edit state, not the pre-edit state
    if (!editModeState.isEditing) {
      editModeState.isEditing = true
      // Use the last history entry as the "before" state
      editModeState.pendingSnapshot =
        historyState.history[historyState.currentIndex] || null
      editModeState.editCount = 0
    }

    editModeState.editCount++
    editModeState.lastEditTime = now

    // Clear existing timer
    if (editModeState.debounceTimer) {
      clearTimeout(editModeState.debounceTimer)
    }

    // Set new timer to save after debounce delay
    editModeState.debounceTimer = setTimeout(() => {
      flushEditHistory()
    }, editModeConfig.debounceDelay)

    // Notify parent of edit activity
    sendToParent('editActivity', {
      editCount: editModeState.editCount,
      pending: true,
    })
  }

  /**
   * Flush pending edit history (save the current edit batch)
   */
  function flushEditHistory() {
    if (!editModeState.isEditing) return

    // Clear timer
    if (editModeState.debounceTimer) {
      clearTimeout(editModeState.debounceTimer)
      editModeState.debounceTimer = null
    }

    // Capture current (post-edit) state
    const currentSnapshot = captureSnapshot('edit', 'Edit changes')

    let didSave = false
    if (
      editModeState.pendingSnapshot &&
      currentSnapshot &&
      editModeState.pendingSnapshot.htmlContent !== currentSnapshot.htmlContent
    ) {
      // pendingSnapshot is a reference to an existing history entry (the pre-edit state),
      // so we only need to save the current post-edit state
      saveToHistory(
        'edit',
        `Edit (${editModeState.editCount} change${editModeState.editCount > 1 ? 's' : ''})`
      )

      console.log(
        `[SandboxInspect] Edit batch saved: ${editModeState.editCount} changes`
      )
      didSave = true
    }

    // Reset edit state
    editModeState.pendingSnapshot = null
    editModeState.editCount = 0
    editModeState.isEditing = false
    editModeState.lastEditTime = 0

    // Notify parent - only report saved: true if we actually saved changes
    sendToParent('editActivity', {
      editCount: 0,
      pending: false,
      saved: didSave,
    })
  }

  /**
   * User-edit tracking via the `input` event.
   *
   * Previously we used a MutationObserver on document.body to drive history
   * snapshots, but that also fired for scripted mutations (AJAX responses,
   * setInterval timers, framework re-renders), which polluted the diff with
   * content the user never touched.
   *
   * The DOM `input` event on a contentEditable root ONLY fires for
   * user-initiated content changes (typing, paste, cut, drop, execCommand).
   * It does NOT fire for scripted DOM writes, so we can safely rely on it to
   * distinguish "user edit" from "page script mutation".
   *
   * Toolbar operations still go through executeWithHistory and call
   * saveToHistory explicitly, bypassing this listener.
   */
  let editInputListenerAttached = false

  function handleEditInputEvent() {
    if (!state.editMode && !state.visualEditMode) return
    handleEditInput()
  }

  function setupEditModeObserver() {
    if (editInputListenerAttached) return
    document.body.addEventListener('input', handleEditInputEvent, true)
    editInputListenerAttached = true
  }

  function teardownEditModeObserver() {
    if (!editInputListenerAttached) return
    document.body.removeEventListener('input', handleEditInputEvent, true)
    editInputListenerAttached = false
  }

  /**
   * Handle click events in edit mode to prevent navigation from links
   * and other interactive elements while allowing text editing.
   */
  function handleEditModeClick(event) {
    if (!state.editMode && !state.visualEditMode) return

    const target = event.target

    // Walk up from the click target to find any ancestor that would
    // cause navigation or unintended actions (a, button, [onclick], etc.)
    let node = target
    while (node && node !== document.body) {
      const tag = node.tagName && node.tagName.toLowerCase()
      if (
        tag === 'a' ||
        tag === 'button' ||
        tag === 'input' ||
        tag === 'select' ||
        tag === 'textarea' ||
        node.getAttribute('onclick') ||
        node.getAttribute('role') === 'button' ||
        node.getAttribute('role') === 'link'
      ) {
        event.preventDefault()
        event.stopPropagation()
        // For links and buttons, focus the element for text editing instead
        if (tag === 'a' || tag === 'button') {
          node.focus()
        }
        return
      }
      node = node.parentElement
    }
  }

  /**
   * Enable edit mode
   */
  function enableEditMode() {
    if (state.editMode) return

    // Disable other modes if enabled
    if (state.enabled) {
      disableInspectMode()
    }
    if (state.visualEditMode) {
      disableVisualEditMode()
    }

    state.editMode = true

    // Enable contentEditable on body
    document.body.contentEditable = 'true'

    // Add edit mode styles
    addEditModeStyles()

    // Prevent navigation from links and interactive elements
    document.addEventListener('click', handleEditModeClick, true)

    // Setup observer to track changes
    setupEditModeObserver()

    // Capture a FRESH baseline (clear any stale history from a previous
    // edit session first). See enableVisualEditMode for the full rationale.
    clearHistory()
    captureInitialState()

    sendToParent('editModeEnabled', { editMode: true })
    console.log('[SandboxInspect] Edit mode enabled')
  }

  /**
   * Disable edit mode
   */
  function disableEditMode() {
    if (!state.editMode) return

    // Flush any pending edits before disabling
    flushEditHistory()

    state.editMode = false

    // Disable contentEditable
    document.body.contentEditable = 'false'

    // Remove edit mode styles
    removeEditModeStyles()

    // Remove edit mode click handler
    document.removeEventListener('click', handleEditModeClick, true)

    // Teardown observer
    teardownEditModeObserver()

    // Reset edit state
    editModeState.pendingSnapshot = null
    editModeState.editCount = 0
    editModeState.isEditing = false
    if (editModeState.debounceTimer) {
      clearTimeout(editModeState.debounceTimer)
      editModeState.debounceTimer = null
    }

    sendToParent('editModeDisabled', { editMode: false })
    console.log('[SandboxInspect] Edit mode disabled')
  }

  /**
   * Add edit mode visual styles
   */
  function addEditModeStyles() {
    if (document.getElementById('__sandbox-edit-mode-styles__')) return

    const style = document.createElement('style')
    style.id = '__sandbox-edit-mode-styles__'
    style.textContent = `
      body[contenteditable="true"] {
        outline: none;
        cursor: text;
      }
      body[contenteditable="true"] *:hover {
        outline: 1px dashed rgba(59, 130, 246, 0.5);
        outline-offset: 2px;
      }
      body[contenteditable="true"] *:focus {
        outline: 2px solid #3b82f6;
        outline-offset: 2px;
      }
      body[contenteditable="true"]::before {
        content: 'Edit Mode';
        position: fixed;
        top: 8px;
        right: 8px;
        background: #3b82f6;
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        font-family: system-ui, sans-serif;
        z-index: 10000;
        pointer-events: none;
      }
    `
    document.head.appendChild(style)
  }

  /**
   * Remove edit mode visual styles
   */
  function removeEditModeStyles() {
    const style = document.getElementById('__sandbox-edit-mode-styles__')
    if (style) {
      style.remove()
    }
  }

  // ============================================
  // Visual Edit Mode (inspect + change tracking)
  // ============================================

  /**
   * Get computed styles for an element (key properties for toolbar display)
   */
  function getComputedElementStyles(element) {
    if (!element) return null
    try {
      const computed = window.getComputedStyle(element)
      return {
        fontSize: computed.fontSize,
        fontFamily: computed.fontFamily,
        fontWeight: computed.fontWeight,
        fontStyle: computed.fontStyle,
        textDecoration: computed.textDecoration,
        textDecorationLine: computed.textDecorationLine,
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        textAlign: computed.textAlign,
        letterSpacing: computed.letterSpacing,
        lineHeight: computed.lineHeight,
        opacity: computed.opacity,
        borderRadius: computed.borderRadius,
      }
    } catch {
      return null
    }
  }

  /**
   * Handle mouseup in visual edit mode — track the active element for the
   * toolbar without blocking contentEditable text cursor placement.
   */
  function handleVisualEditMouseUp(event) {
    if (!state.visualEditMode) return

    let element = event.target
    if (isExcludedElement(element)) return

    // Same element — skip redundant update
    if (state.selectedElement === element) return

    state.selectedElement = element
    const elementInfo = getElementInfo(element)
    if (elementInfo && element.outerHTML) {
      const html = element.outerHTML
      elementInfo.outerHTML =
        html.length > 1000 ? html.slice(0, 1000) + '...' : html
    }
    sendToParent('select', {
      element: elementInfo,
      styles: getComputedElementStyles(element),
    })
  }

  /**
   * Enable visual edit mode — contentEditable + hover borders + toolbar.
   * Combines the old edit mode (text editing, element deletion) with
   * element-aware toolbar for style adjustments.
   */
  /**
   * Intercept Ctrl+Z / Ctrl+Y (Cmd on Mac) so keyboard undo/redo goes
   * through our snapshot history instead of the browser's built-in stack.
   */
  function handleVisualEditKeyDown(event) {
    if (!state.visualEditMode) return
    const isMod = event.ctrlKey || event.metaKey
    if (!isMod) return

    const key = event.key.toLowerCase()
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      undo()
    } else if (key === 'z' && event.shiftKey) {
      event.preventDefault()
      redo()
    } else if (key === 'y') {
      event.preventDefault()
      redo()
    }
  }

  function enableVisualEditMode() {
    if (state.visualEditMode) return

    // Preload Rangy when visual edit mode is first enabled
    loadRangy()

    // Disable other modes if enabled
    if (state.enabled) {
      disableInspectMode()
    }
    if (state.editMode) {
      disableEditMode()
    }

    state.visualEditMode = true

    // Enable contentEditable so the user can type / delete / paste
    document.body.contentEditable = 'true'

    // Hover borders for visual feedback (does NOT preventDefault)
    document.addEventListener('mouseover', handleMouseOver, true)
    document.addEventListener('mouseout', handleMouseOut, true)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleResize, true)

    // Track active element on mouseup (does NOT preventDefault — text
    // cursor, selection, and contentEditable all keep working)
    document.addEventListener('mouseup', handleVisualEditMouseUp, true)

    // Prevent navigation from links and interactive elements
    document.addEventListener('click', handleEditModeClick, true)

    // Intercept Ctrl+Z/Y for our snapshot-based undo/redo
    document.addEventListener('keydown', handleVisualEditKeyDown, true)

    // Setup mutation observer for change tracking
    setupEditModeObserver()

    // Capture a FRESH baseline. We clear any stale history first so the
    // baseline reflects the DOM as it exists *right now*, including any
    // AJAX/timer-driven changes that have landed since a previous edit
    // session. Otherwise re-opening edit mode would keep an older
    // `history[0]` and the diff would surface every scripted mutation that
    // happened in between as if the user had made it.
    clearHistory()
    captureInitialState()

    // Add visual styles
    addVisualEditModeStyles()

    sendToParent('visualEditModeEnabled', { visualEditMode: true })
    console.log('[SandboxInspect] Visual edit mode enabled')
  }

  /**
   * Disable visual edit mode
   */
  function disableVisualEditMode() {
    if (!state.visualEditMode) return

    // Flush any pending edits
    flushEditHistory()

    state.visualEditMode = false

    // Disable contentEditable
    document.body.contentEditable = 'false'

    // Remove event listeners
    document.removeEventListener('mouseover', handleMouseOver, true)
    document.removeEventListener('mouseout', handleMouseOut, true)
    window.removeEventListener('scroll', handleScroll, true)
    window.removeEventListener('resize', handleResize, true)
    document.removeEventListener('mouseup', handleVisualEditMouseUp, true)
    document.removeEventListener('click', handleEditModeClick, true)
    document.removeEventListener('keydown', handleVisualEditKeyDown, true)

    // Cancel throttled functions
    handleScroll.cancel()
    handleResize.cancel()

    // Teardown observer
    teardownEditModeObserver()

    // Reset edit state
    editModeState.pendingSnapshot = null
    editModeState.editCount = 0
    editModeState.isEditing = false
    if (editModeState.debounceTimer) {
      clearTimeout(editModeState.debounceTimer)
      editModeState.debounceTimer = null
    }

    // Clear element state directly without sending 'cleared' message
    // (the 'cleared' message triggers clearAllSelections which wipes editDiff)
    state.hoveredElement = null
    state.selectedElement = null

    // Remove visual styles
    removeVisualEditModeStyles()

    sendToParent('visualEditModeDisabled', { visualEditMode: false })
    console.log('[SandboxInspect] Visual edit mode disabled')
  }

  // ============================================================
  // Range-aware style application (ported from HtmlEditor/formatOperations.js)
  // Uses Rangy for cross-element selections, native Range as fallback.
  // ============================================================

  // Block-level properties that always apply to the element, never span-wrapped
  const BLOCK_STYLE_PROPERTIES = new Set([
    'textAlign',
    'lineHeight',
    'margin',
    'marginTop',
    'marginBottom',
    'marginLeft',
    'marginRight',
    'padding',
    'paddingTop',
    'paddingBottom',
    'paddingLeft',
    'paddingRight',
    'display',
    'width',
    'height',
    'maxWidth',
    'maxHeight',
    'minWidth',
    'minHeight',
  ])

  const BLOCK_TAGS = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'DETAILS',
    'DIALOG',
    'DD',
    'DIV',
    'DL',
    'DT',
    'FIELDSET',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'FORM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HGROUP',
    'HR',
    'LI',
    'MAIN',
    'NAV',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'TABLE',
    'UL',
  ])

  /** Dynamically load Rangy from CDN (with SRI, retryable on failure). */
  let _rangyPromise = null
  function loadRangy() {
    if (window.rangy) return Promise.resolve(window.rangy)
    if (_rangyPromise) return _rangyPromise
    _rangyPromise = new Promise(resolve => {
      const script = document.createElement('script')
      script.src =
        'https://cdn.jsdelivr.net/npm/rangy@1.3.1/lib/rangy-core.min.js'
      script.integrity =
        'sha384-ci3T2HPmJaYtkF0W001nYQeFAVKGTHyiFYBfCzL7GdzHYDrOq+hBGClLodongce+'
      script.crossOrigin = 'anonymous'
      script.onload = () => {
        try {
          if (window.rangy && typeof window.rangy.init === 'function') {
            window.rangy.init()
          }
        } catch (_) {
          _rangyPromise = null
        }
        resolve(window.rangy || null)
      }
      script.onerror = () => {
        _rangyPromise = null // allow retry on next call
        resolve(null)
      }
      document.head.appendChild(script)
    })
    return _rangyPromise
  }

  /** Check if selection contains actual selected text. */
  function hasValidTextSelection(selection) {
    return (
      selection &&
      selection.rangeCount > 0 &&
      !selection.getRangeAt(0).collapsed &&
      selection.toString().trim() !== ''
    )
  }

  /**
   * Apply a styles object to an element.
   */
  function applyStylesToEl(el, styles) {
    for (const [p, v] of Object.entries(styles)) {
      el.style[p] = v
    }
  }

  /**
   * Split a text node and wrap the selected portion in a <span> with styles.
   * If the parent is already a <span>, splits it to avoid deep nesting.
   * Accepts a styles object so all properties are applied in one pass.
   * (Ported from formatOperations.js splitAndWrapTextNode)
   */
  function splitAndWrapTextNode(textNode, startOffset, endOffset, styles) {
    if (startOffset >= endOffset || !textNode.textContent) return
    const fullText = textNode.textContent
    const beforeText = fullText.substring(0, startOffset)
    const selectedText = fullText.substring(startOffset, endOffset)
    const afterText = fullText.substring(endOffset)
    if (!selectedText.trim()) return

    const fragment = document.createDocumentFragment()
    const parentEl = textNode.parentNode

    if (parentEl && parentEl.tagName === 'SPAN' && parentEl !== document.body) {
      // Parent is a span — split it to avoid nesting
      const origCSS = parentEl.style.cssText
      if (beforeText) {
        const s = document.createElement('span')
        s.style.cssText = origCSS
        s.textContent = beforeText
        fragment.appendChild(s)
      }
      const sel = document.createElement('span')
      sel.style.cssText = origCSS
      applyStylesToEl(sel, styles)
      sel.textContent = selectedText
      fragment.appendChild(sel)
      if (afterText) {
        const s = document.createElement('span')
        s.style.cssText = origCSS
        s.textContent = afterText
        fragment.appendChild(s)
      }
      parentEl.parentNode.insertBefore(fragment, parentEl)
      parentEl.parentNode.removeChild(parentEl)
      return
    }

    // Normal case — wrap in a new span
    if (beforeText) fragment.appendChild(document.createTextNode(beforeText))
    const span = document.createElement('span')
    applyStylesToEl(span, styles)
    span.textContent = selectedText
    fragment.appendChild(span)
    if (afterText) fragment.appendChild(document.createTextNode(afterText))
    textNode.parentNode.insertBefore(fragment, textNode)
    textNode.parentNode.removeChild(textNode)
  }

  /**
   * Collect text node infos from a Rangy range.
   * Returns array of { textNode, startOffset, endOffset, blockParent }.
   */
  function collectTextNodeInfos(range) {
    const textNodes = range.getNodes([Node.TEXT_NODE])
    const infos = []

    textNodes.forEach(textNode => {
      if (!textNode.textContent.trim()) return
      let startOffset = 0
      let endOffset = textNode.textContent.length

      try {
        if (range.startContainer === textNode) {
          startOffset = range.startOffset
        } else {
          if (range.comparePoint(textNode, 0) < 0) return
        }
        if (range.endContainer === textNode) {
          endOffset = range.endOffset
        } else {
          if (range.comparePoint(textNode, textNode.textContent.length) > 0)
            return
        }
      } catch (_) {
        return // skip this node if boundary check fails
      }

      if (startOffset < endOffset) {
        const selected = textNode.textContent.substring(startOffset, endOffset)
        if (selected.trim()) {
          let blockParent = textNode.parentElement
          while (blockParent && !BLOCK_TAGS.has(blockParent.tagName)) {
            blockParent = blockParent.parentElement
          }
          infos.push({ textNode, startOffset, endOffset, blockParent })
        }
      }
    })
    return infos
  }

  /**
   * Apply styles to all text nodes in a Rangy range.
   * Groups by block parent, processes end-to-start to avoid offset shifts.
   * (Ported from formatOperations.js applyStyleToRangyRange)
   */
  function applyStylesToRangyRange(range, styles) {
    const infos = collectTextNodeInfos(range)

    // Group by block parent, process each group from end to start
    const groups = new Map()
    infos.forEach(info => {
      const key = info.blockParent || document.body
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(info)
    })

    Array.from(groups.entries())
      .reverse()
      .forEach(([, items]) => {
        // Sort by document order (matching formatOperations.js)
        items.sort((a, b) => {
          const pos = a.textNode.compareDocumentPosition(b.textNode)
          return pos & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1
        })
        items.forEach(info => {
          splitAndWrapTextNode(
            info.textNode,
            info.startOffset,
            info.endOffset,
            styles
          )
        })
      })
  }

  /**
   * Native fallback when Rangy is unavailable — simple span wrap.
   * All styles applied at once.
   */
  function applyStylesNativeFallback(selection, styles) {
    const range = selection.getRangeAt(0)
    const selectedText = selection.toString()
    const span = document.createElement('span')
    applyStylesToEl(span, styles)
    span.textContent = selectedText

    range.deleteContents()
    range.insertNode(span)

    // Place cursor after span
    selection.removeAllRanges()
    const newRange = document.createRange()
    newRange.setStartAfter(span)
    newRange.collapse(true)
    selection.addRange(newRange)
  }

  /**
   * Apply styles to the current text selection in a single pass.
   * Tries Rangy for cross-element support, falls back to native.
   * (Ported from formatOperations.js applyStyleToSelection)
   */
  function applyStylesToSelection(selection, styles) {
    if (!hasValidTextSelection(selection)) return

    const rangy = window.rangy
    if (rangy && typeof rangy.getSelection === 'function') {
      try {
        const rangySelection = rangy.getSelection(window)
        if (rangySelection && rangySelection.rangeCount > 0) {
          for (let i = 0; i < rangySelection.rangeCount; i++) {
            const range = rangySelection.getRangeAt(i)
            if (!range.collapsed) {
              applyStylesToRangyRange(range, styles)
            }
          }
          return
        }
      } catch (_) {
        // Rangy failed, fall through to native
      }
    }

    // Native fallback
    applyStylesNativeFallback(selection, styles)
  }

  /**
   * Clear specific inline styles from all descendant elements.
   * (Ported from formatOperations.js clearDescendantStyle)
   */
  function clearDescendantStyles(element, styleProperties) {
    if (!element) return
    const descendants = element.querySelectorAll('*')
    descendants.forEach(el => {
      if (!el.style) return
      for (const prop of styleProperties) {
        if (el.style[prop]) {
          el.style[prop] = ''
        }
      }
      if (!el.getAttribute('style') || el.getAttribute('style').trim() === '') {
        el.removeAttribute('style')
      }
    })
  }

  /**
   * Apply inline styles — follows HtmlEditor's exact pattern:
   *  1. Block-level properties (textAlign, width, …) → always on the element
   *  2. Has text selection? → applyStylesToSelection (Rangy → native fallback)
   *     All inline properties applied in one pass to avoid selection invalidation.
   *  3. Has selectedElement but no text selection? → element.style[prop] = value
   *     with clearDescendantStyles first (so parent style takes effect uniformly)
   */
  function applyStylesToSelectedElement(styles) {
    if (!styles) return

    // Separate block-level vs inline properties
    const blockStyles = {}
    const inlineStyles = {}
    for (const [p, v] of Object.entries(styles)) {
      if (BLOCK_STYLE_PROPERTIES.has(p)) {
        blockStyles[p] = v
      } else {
        inlineStyles[p] = v
      }
    }

    const selection = window.getSelection()
    const hasTextSel =
      Object.keys(inlineStyles).length > 0 && hasValidTextSelection(selection)

    // Guard: nothing to do if no element selected and no text selection
    const hasBlockWork =
      Object.keys(blockStyles).length > 0 && state.selectedElement
    const hasInlineWork =
      Object.keys(inlineStyles).length > 0 &&
      (hasTextSel || state.selectedElement)
    if (!hasBlockWork && !hasInlineWork) return

    executeWithHistory('Apply styles', () => {
      // Block-level: always on the element
      if (hasBlockWork) {
        applyStylesToEl(state.selectedElement, blockStyles)
      }

      if (Object.keys(inlineStyles).length === 0) return

      if (hasTextSel) {
        // Inline + text selected: single-pass range-based (Rangy or native)
        applyStylesToSelection(selection, inlineStyles)
      } else if (state.selectedElement) {
        // Inline + no text selected: element-level
        clearDescendantStyles(state.selectedElement, Object.keys(inlineStyles))
        applyStylesToEl(state.selectedElement, inlineStyles)
      }
    })
  }

  /**
   * Send computed styles of the selected element to parent
   */
  function sendSelectedElementStyles() {
    const styles = getComputedElementStyles(state.selectedElement)
    sendToParent('elementStyles', { styles: styles })
  }

  /**
   * Re-send the selected element's info (including updated rect) to parent.
   * Called after DOM changes (e.g. resize) that invalidate the cached rect.
   */
  function resendSelectedElementInfo() {
    if (!state.selectedElement) return
    const elementInfo = getElementInfo(state.selectedElement)
    if (elementInfo && state.selectedElement.outerHTML) {
      const html = state.selectedElement.outerHTML
      elementInfo.outerHTML =
        html.length > 1000 ? html.slice(0, 1000) + '...' : html
    }
    sendToParent('select', {
      element: elementInfo,
      styles: getComputedElementStyles(state.selectedElement),
    })
  }

  /**
   * Add visual edit mode styles
   */
  function addVisualEditModeStyles() {
    if (document.getElementById('__sandbox-visual-edit-mode-styles__')) return

    const style = document.createElement('style')
    style.id = '__sandbox-visual-edit-mode-styles__'
    style.textContent = `
      body[contenteditable="true"] {
        outline: none;
      }
      body.__visual-edit-mode__ *:hover {
        outline: 1px dashed rgba(59, 130, 246, 0.5);
        outline-offset: 2px;
      }
      body.__visual-edit-mode__ *:focus {
        outline: 2px solid #3b82f6;
        outline-offset: 2px;
      }
      body.__visual-edit-mode__::before {
        content: 'Edit';
        position: fixed;
        top: 8px;
        right: 8px;
        background: #8b5cf6;
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        font-family: system-ui, sans-serif;
        z-index: 10000;
        pointer-events: none;
      }
    `
    document.head.appendChild(style)
    document.body.classList.add('__visual-edit-mode__')
  }

  /**
   * Remove visual edit mode styles
   */
  function removeVisualEditModeStyles() {
    const style = document.getElementById('__sandbox-visual-edit-mode-styles__')
    if (style) {
      style.remove()
    }
    document.body.classList.remove('__visual-edit-mode__')
  }

  // ============================================
  // Inspect Mode Control
  // ============================================

  /**
   * Enable inspect mode
   */
  function enableInspectMode() {
    if (state.enabled) return

    // Disable other modes if enabled
    if (state.editMode) {
      disableEditMode()
    }
    if (state.visualEditMode) {
      disableVisualEditMode()
    }

    state.enabled = true

    // Add event listeners
    document.addEventListener('mouseover', handleMouseOver, true)
    document.addEventListener('mouseout', handleMouseOut, true)
    document.addEventListener('click', handleClick, true)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleResize, true)

    // Add drag event listeners
    document.addEventListener('mousedown', handleMouseDown, true)
    document.addEventListener('mousemove', handleDragMove, true)
    document.addEventListener('mouseup', handleMouseUp, true)

    // Setup mutation observer
    setupMutationObserver()

    // Add visual indicator
    document.body.style.cursor = 'crosshair'

    sendToParent('enabled', { enabled: true })
    console.log('[SandboxInspect] Inspect mode enabled')
  }

  /**
   * Disable inspect mode
   */
  function disableInspectMode() {
    if (!state.enabled) return

    state.enabled = false

    // Remove event listeners
    document.removeEventListener('mouseover', handleMouseOver, true)
    document.removeEventListener('mouseout', handleMouseOut, true)
    document.removeEventListener('click', handleClick, true)
    window.removeEventListener('scroll', handleScroll, true)
    window.removeEventListener('resize', handleResize, true)

    // Remove drag event listeners
    document.removeEventListener('mousedown', handleMouseDown, true)
    document.removeEventListener('mousemove', handleDragMove, true)
    document.removeEventListener('mouseup', handleMouseUp, true)

    // Clean up any drag state
    if (state.isDragging) {
      if (state.dragElement) {
        state.dragElement.style.opacity = ''
        state.dragElement.style.pointerEvents = ''
      }
      document.body.style.cursor = ''
      removeDragGhost()
      removeDropIndicator()
      state.isDragging = false
      state.dragElement = null
      state.dropTarget = null
      state.dropPosition = null
    }

    // Cancel throttled functions
    handleScroll.cancel()
    handleResize.cancel()

    // Teardown mutation observer
    teardownMutationObserver()

    // Clear states
    clearAllStates()

    // Remove visual indicator
    document.body.style.cursor = ''

    sendToParent('disabled', { enabled: false })
    console.log('[SandboxInspect] Inspect mode disabled')
  }

  /**
   * Clear all states
   */
  function clearAllStates() {
    const hadSelection = state.selectedElement !== null
    const hadHover = state.hoveredElement !== null

    state.hoveredElement = null
    state.selectedElement = null

    if (hadSelection || hadHover) {
      sendToParent('cleared', {
        hoveredElement: null,
        selectedElement: null,
      })
    }
  }

  // ============================================
  // Initialization
  // ============================================

  /**
   * Initialize the library
   */
  function init() {
    // Listen for messages from parent
    window.addEventListener('message', handleParentMessage)

    // Preload diff-dom early for faster diff computation
    loadDiffDom().then(success => {
      if (success) {
        console.log('[SandboxInspect] diff-dom preloaded')
      }
    })

    // Capture initial state for history
    captureInitialState()

    // Notify parent that we're ready
    sendToParent('ready', {
      url: window.location.href,
      title: document.title,
      historyInfo: getHistoryInfo(),
    })

    console.log('[SandboxInspect] Library loaded and ready')
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // ============================================
  // Public API (for debugging)
  // ============================================
  window.__SandboxInspect__ = {
    // Inspect mode
    enable: enableInspectMode,
    disable: disableInspectMode,
    clear: clearAllStates,
    getState: () => ({
      enabled: state.enabled,
      editMode: state.editMode,
      visualEditMode: state.visualEditMode,
      hoveredElement: state.hoveredElement,
      selectedElement: state.selectedElement,
    }),
    getElementInfo: getElementInfo,
    getCssPath: getCssPath,
    // History API
    undo: undo,
    redo: redo,
    getHistoryInfo: getHistoryInfo,
    clearHistory: clearHistory,
    saveToHistory: saveToHistory,
    // Edit mode API
    enableEditMode: enableEditMode,
    disableEditMode: disableEditMode,
    flushEditHistory: flushEditHistory,
    isEditMode: () => state.editMode,
    // Visual edit mode API
    enableVisualEditMode: enableVisualEditMode,
    disableVisualEditMode: disableVisualEditMode,
    applyStyle: applyStylesToSelectedElement,
    getElementStyles: () => getComputedElementStyles(state.selectedElement),
    isVisualEditMode: () => state.visualEditMode,
  }
})()
