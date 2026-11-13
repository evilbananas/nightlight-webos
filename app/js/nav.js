/* D-pad focus manager. Rows are `.nav-row` elements; items are their visible `.focusable`
 * children. Up/Down moves between rows, Left/Right moves within a row, unless the focused
 * item is adjustable (segmented control / stepper), in which case Left/Right changes it. */
var Nav = (function () {
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 461, ESC: 27 };
  var current = null;
  var handlers = { adjust: null, back: null };

  function visible(el) {
    return el.offsetParent !== null && !el.disabled;
  }

  function toArray(list) {
    return Array.prototype.slice.call(list);
  }

  function rows() {
    return toArray(document.querySelectorAll('.nav-row')).filter(function (r) {
      return visible(r) && items(r).length > 0;
    });
  }

  function items(row) {
    return toArray(row.querySelectorAll('.focusable')).filter(visible);
  }

  function rowOf(el) {
    while (el && !(el.classList && el.classList.contains('nav-row'))) el = el.parentNode;
    return el;
  }

  function focus(el) {
    if (!el || el === current) return;
    if (current) current.classList.remove('focused');
    current = el;
    el.classList.add('focused');
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(false);
    else if (el.scrollIntoView) el.scrollIntoView(false);
  }

  function ensureFocus() {
    if (current && visible(current) && document.body.contains(current)) return;
    if (current) current.classList.remove('focused');
    current = null;
    var r = rows();
    if (r.length) focus(items(r[0])[0]);
  }

  function moveRow(dir) {
    var r = rows();
    var row = rowOf(current);
    var idx = r.indexOf(row);
    var col = row ? items(row).indexOf(current) : 0;
    var target = r[idx + dir];
    if (!target) return;
    var its = items(target);
    focus(its[Math.min(Math.max(col, 0), its.length - 1)]);
  }

  function moveCol(dir) {
    var its = items(rowOf(current));
    var target = its[its.indexOf(current) + dir];
    if (target) focus(target);
  }

  function isAdjustable(el) {
    return el.classList.contains('seg') || el.classList.contains('stepper');
  }

  function isInput(el) {
    return el && el.tagName === 'INPUT';
  }

  function onKey(e) {
    var key = e.keyCode;
    ensureFocus();
    if (!current) return;

    // While a text field is being edited, only Enter/Up/Down/Back leave it.
    if (isInput(document.activeElement)) {
      if (key === KEY.ENTER || key === KEY.UP || key === KEY.DOWN || key === KEY.BACK || key === KEY.ESC) {
        document.activeElement.blur();
        if (key === KEY.UP) moveRow(-1);
        if (key === KEY.DOWN) moveRow(1);
        e.preventDefault();
      }
      return;
    }

    switch (key) {
      case KEY.UP: moveRow(-1); break;
      case KEY.DOWN: moveRow(1); break;
      case KEY.LEFT:
      case KEY.RIGHT:
        var dir = key === KEY.LEFT ? -1 : 1;
        if (isAdjustable(current) && handlers.adjust) handlers.adjust(current, dir);
        else moveCol(dir);
        break;
      case KEY.ENTER:
        if (isInput(current)) current.focus();
        else if (current.tagName === 'BUTTON') current.click();
        else if (isAdjustable(current) && handlers.adjust) handlers.adjust(current, 0);
        break;
      case KEY.BACK:
      case KEY.ESC:
        if (handlers.back) handlers.back();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function init(opts) {
    handlers.adjust = opts.adjust;
    handlers.back = opts.back;
    document.addEventListener('keydown', onKey, false);
    // Magic Remote pointer: focus follows the cursor.
    document.addEventListener('mouseover', function (e) {
      var el = e.target;
      while (el && el !== document && !(el.classList && el.classList.contains('focusable'))) el = el.parentNode;
      if (el && el !== document && visible(el)) focus(el);
    }, false);
    ensureFocus();
  }

  return { init: init, ensureFocus: ensureFocus, focus: focus };
})();
