/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1
 *
 * The contents of this file are subject to the Mozilla Public License
 * Version 1.1 (the "License"); you may not use this file except in
 * compliance with the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS"
 * basis, WITHOUT WARRANTY OF ANY KIND, either express or implied.
 * See the License for the specific language governing rights and
 * limitations under the License.
 *
 * The Original Code is Bespin.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Bespin Team (bespin@mozilla.com)
 *
 * ***** END LICENSE BLOCK ***** */

var SC = require('sproutcore/runtime').SC;
var CanvasView = require('views/canvas').CanvasView;
var LayoutManager = require('controllers/layoutmanager').LayoutManager;
var MultiDelegateSupport =
    require('mixins/multidelegate').MultiDelegateSupport;
var Range = require('utils/range');
var Rect = require('utils/rect');
var TextInput = require('bespin:editor/mixins/textinput').TextInput;
var keyboardManager = require('Canon:keyboard').keyboardManager;

exports.TextView = CanvasView.extend(MultiDelegateSupport, TextInput, {
    _dragPoint: null,
    _dragTimer: null,
    _inChangeGroup: false,

    // TODO: calculate from the size or let the user override via themes if
    // desired
    _lineAscent: 16,

    _selectedRanges: null,
    _selectionOrigin: null,
    _virtualInsertionPoint: null,

    _beginChangeGroup: function() {
        if (this._inChangeGroup) {
            throw "TextView._beginChangeGroup() called while already in a " +
                "change group";
        }

        this._inChangeGroup = true;
        this.notifyDelegates('textViewBeganChangeGroup', this._selectedRanges);
    },

    _drag: function() {
        var point = this.convertFrameFromView(this._dragPoint);
        var offset = Rect.offsetFromRect(this.get('clippingFrame'), point);

        this._extendSelectionFromStandardOrigin(this.
            _selectionPositionForPoint({
                x:  point.x - offset.x,
                y:  point.y - offset.y
            }));

        this.becomeFirstResponder();
    },

    // Draws a single insertion point.
    _drawInsertionPoint: function(rect, context) {
        var range = this._selectedRanges[0];
        var characterRect = this.get('layoutManager').
            characterRectForPosition(range.start);

        context.save();

        context.strokeStyle = this.get('theme').cursorStyle;
        context.beginPath();
        context.moveTo(characterRect.x + 0.5, characterRect.y);
        context.lineTo(characterRect.x + 0.5,
            characterRect.y + characterRect.height);
        context.closePath();
        context.stroke();

        context.restore();
    },

    _drawLines: function(rect, context) {
        var layoutManager = this.get('layoutManager');
        var textLines = layoutManager.get('textLines');
        var theme = this.get('theme');
        var lineAscent = this._lineAscent;

        context.save();
        context.font = theme.editorTextFont;

        var range = layoutManager.characterRangeForBoundingRect(rect);
        var rangeStart = range.start, rangeEnd = range.end;
        var startRow = rangeStart.row, endRow = rangeEnd.row;
        for (var row = startRow; row <= endRow; row++) {
            var textLine = textLines[row];
            if (SC.none(textLine)) {
                continue;
            }

            // Clamp the start column and end column to fit within the line
            // text.
            var characters = textLine.characters;
            var length = characters.length;
            var endColumn = Math.min(rangeEnd.column, length);
            var startColumn = rangeStart.column;
            if (startColumn >= length) {
                continue;
            }

            // Figure out which color range to start in.
            var colorRanges = textLine.colors;
            var colorIndex = 0;
            while (startColumn < colorRanges[colorIndex].start) {
                colorIndex++;
            }

            // And finally draw the line.
            var column = startColumn;
            while (column < endColumn) {
                var colorRange = colorRanges[colorIndex];
                var colorRangeEnd = colorRange.end;
                context.fillStyle = colorRange.color;

                var characterRect = layoutManager.characterRectForPosition({
                    row:    row,
                    column: column
                });
                context.fillText(characters.substring(column, colorRangeEnd),
                    characterRect.x, characterRect.y + lineAscent);

                column = colorRangeEnd;
                colorIndex++;
            }
        }

        context.restore();
    },

    // Draws the background highlight for selections.
    _drawSelectionHighlight: function(rect, context) {
        var theme = this.get('theme');
        var fillStyle = this.get('isFirstResponder') ?
            theme.editorSelectedTextBackground :
            theme.unfocusedCursorFillStyle;
        var layoutManager = this.get('layoutManager');

        context.save();

        this._selectedRanges.forEach(function(range) {
            context.fillStyle = fillStyle;
            layoutManager.rectsForRange(range).forEach(function(rect) {
                context.fillRect(rect.x, rect.y, rect.width, rect.height);
            });
        }, this);

        context.restore();
    },

    // Draws either the selection or the insertion point.
    _drawSelection: function(rect, context) {
        if (this._rangeSetIsInsertionPoint(this._selectedRanges)) {
            this._drawInsertionPoint(rect, context);
        } else {
            this._drawSelectionHighlight(rect, context);
        }
    },

    _endChangeGroup: function() {
        if (!this._inChangeGroup) {
            throw "TextView._endChangeGroup() called while not in a change " +
                "group";
        }

        this._inChangeGroup = false;
        this.notifyDelegates('textViewEndedChangeGroup', this._selectedRanges);
    },

    // Extends the selection from the origin in the natural way (as opposed to
    // rectangular selection).
    _extendSelectionFromStandardOrigin: function(position) {
        var origin = this._selectionOrigin;
        this.setSelection([
            Range.comparePositions(position, origin) < 0 ?
            { start: position, end: origin } :
            { start: origin, end: position }
        ]);
    },

    // Returns the virtual insertion point, which is the origin used for
    // vertical movement. Normally, the virtual insertion point is the same as
    // the actual insertion point, but when the cursor moves vertically, the
    // column of the virtual insertion point remains the same.
    _getVirtualInsertionPoint: function() {
        var point = this._virtualInsertionPoint;
        return point === null ? this._selectedRanges[0].start : point;
    },

    // Replaces the selection with the given text and updates the selection
    // boundaries appropriately.
    _insertText: function(text) {
        var selectedRanges = this._selectedRanges;
        var textStorage = this.getPath('layoutManager.textStorage');

        // Delete text from all ranges except the first (in reverse order, so
        // that we don't have to check and update positions as we go), then
        // overwrite the first selected range with the text. This is
        // "Cocoa-style" behavior, not "TextMate-style".
        for (var i = selectedRanges.length - 1; i > 0; i--) {
            this._replaceCharacters(selectedRanges[i], "");
        }

        var firstRange = selectedRanges[0];
        this._replaceCharacters(firstRange, text);

        // Update the selection to point immediately after the inserted text.
        var lines = text.split("\n");
        this._reanchorSelection(lines.length > 1 ?
            {
                row:    firstRange.start.row + lines.length - 1,
                column: lines[lines.length - 1].length
            } :
            Range.addPositions(firstRange.start,
                { row: 0, column: text.length }));
    },

    _invalidateInsertionPointIfNecessary: function(rangeSet) {
        if (!this._rangeSetIsInsertionPoint(rangeSet)) {
            return;
        }

        var rect = this.get('layoutManager').
            characterRectForPosition(rangeSet[0].start);
        this.setNeedsDisplayInRect({
            x:      rect.x,
            y:      rect.y,
            width:  1,
            height: rect.height
        });
    },

    _performVerticalKeyboardSelection: function(offset) {
        var oldPosition = this._virtualInsertionPoint !== null ?
            this._virtualInsertionPoint : this._selectionTail();
        var newPosition = Range.addPositions(oldPosition,
            { row: offset, column: 0 });
        var clampedPosition = this.getPath('layoutManager.textStorage').
            clampPosition(newPosition);

        this._extendSelectionFromStandardOrigin(clampedPosition);

        // Never let the virtual insertion point's row go beyond the boundaries
        // of the text.
        this._virtualInsertionPoint = {
            row:    clampedPosition.row,
            column: newPosition.column
        };
    },

    _rangeSetIsInsertionPoint: function(rangeSet) {
        return Range.isZeroLength(rangeSet[0]);
    },

    // Clears out the selection, moves the selection origin and the insertion
    // point to the given position, and scrolls to the new selection.
    _reanchorSelection: function(newPosition) {
        this.setSelection([ { start: newPosition, end: newPosition } ]);
        this._selectionOrigin = newPosition;
        this._scrollToPosition(newPosition);
    },

    // Replaces the characters in the range with the given characters, and
    // notifies the delegates (typically the undo controller).
    _replaceCharacters: function(oldRange, characters) {
        if (!this._inChangeGroup) {
            throw "TextView._replaceCharacters() called without a change " +
                "group";
        }

        this.notifyDelegates('textViewWillReplaceRange', oldRange);

        this.getPath('layoutManager.textStorage').replaceCharacters(oldRange,
            characters);

        this.notifyDelegates('textViewReplacedCharacters', oldRange,
            characters);
    },

    // Moves the selection, if necessary, to keep all the positions pointing to
    // actual characters.
    _repositionSelection: function() {
        var textLines = this.get('layoutManager').get('textLines');
        var textLineLength = textLines.length;

        this.setSelection(this._selectedRanges.map(function(range) {
            var newStartRow = Math.min(range.start.row, textLineLength);
            var newEndRow = Math.min(range.end.row, textLineLength);
            var startLine = textLines[newStartRow];
            var endLine = textLines[newEndRow];
            return {
                start:  {
                    row:    newStartRow,
                    column: Math.min(range.start.column,
                                startLine.characters.length)
                },
                end:    {
                    row:    newEndRow,
                    column: Math.min(range.end.column,
                                endLine.characters.length)
                }
            };
        }));
    },

    _resize: function() {
        var boundingRect = this.get('layoutManager').boundingRect();
        var padding = this.get('padding');
        this.set('layout', SC.mixin(SC.clone(this.get('layout')), {
            width:  boundingRect.width + padding.right,
            height: boundingRect.height + padding.bottom
        }));
    },

    _scrollToPosition: function(position) {
        var scrollable = this._scrollView();
        if (SC.none(scrollable)) {
            return;
        }

        var rect = this.get('layoutManager').
            characterRectForPosition(position);
        var rectX = rect.x, rectY = rect.y;
        var rectWidth = rect.width, rectHeight = rect.height;

        var frame = this.get('clippingFrame');
        var frameX = frame.x, frameY = frame.y;

        var padding = this.get('padding');
        var width = frame.width - padding.right;
        var height = frame.height - padding.bottom;

        scrollable.scrollTo(rectX >= frameX &&
            rectX + rectWidth < frameX + width ?
            frameX : rectX - width / 2 + rectWidth / 2,
            rectY >= frameY &&
            rectY + rectHeight < frameY + height ?
            frameY : rectY - height / 2 + rectHeight / 2);
    },

    _scrollWhileDragging: function() {
        var scrollView = this._scrollView();
        if (SC.none(scrollView)) {
            return;
        }

        var offset = Rect.offsetFromRect(this.get('clippingFrame'),
            this.convertFrameFromView(this._dragPoint));
        if (offset.x === 0 && offset.y === 0) {
            return;
        }

        scrollView.scrollBy(offset.x, offset.y);
        this._drag();
    },

    /**
     * @private
     *
     * Returns the parent scroll view, if one exists.
     */
    _scrollView: function() {
        var view = this.get('parentView');
        while (!SC.none(view) && !view.get('isScrollable')) {
            view = view.get('parentView');
        }
        return view;
    },

    // Returns the position of the tail of the selection, or the farthest
    // position within the selection from the origin.
    _selectionTail: function() {
        var ranges = this._selectedRanges;
        return Range.comparePositions(ranges[0].start,
                this._selectionOrigin) === 0 ?
            ranges[ranges.length - 1].end : // selection extends down
            ranges[0].start;                // selection extends up
    },

    // Returns the character closest to the given point, obeying the selection
    // rules (including the partialFraction field).
    _selectionPositionForPoint: function(point) {
        var position = this.get('layoutManager').characterAtPoint(point);
        return position.partialFraction < 0.5 ? position :
            Range.addPositions(position, { row: 0, column: 1 });
    },

    acceptsFirstResponder: true,

    /**
     * @property{Boolean}
     *
     * This property is always true for objects that expose a padding property.
     * The BespinScrollView uses this.
     */
    hasPadding: true,

    /**
     * @property
     *
     * The layer frame, which fills the parent view. Not cacheable, because it
     * depends on the frame of the parent view.
     */
    layerFrame: function() {
        var parentView = this.get('parentView');
        var parentFrame = parentView.get('frame');
        return {
            x:      0,
            y:      0,
            width:  parentFrame.width,
            height: parentFrame.height
        };
    }.property(),

    /**
     * @property
     *
     * The layout manager from which this editor view receives text.
     */
    layoutManager: null,

    /**
     * @property
     *
     * The padding to leave inside the clipping frame, given as an object with
     * 'bottom' and 'right' properties. Text content is displayed inside this
     * padding as usual, but the cursor cannot enter it. In a BespinScrollView,
     * this feature is used to prevent the cursor from ever going behind the
     * scroll bars.
     */
    padding: { bottom: 0, right: 0 },

    /**
     * @property
     *
     * The theme to use.
     *
     * TODO: Convert to a SproutCore theme. This is super ugly.
     */
    theme: {
        backgroundStyle: "#2a211c",
        cursorStyle: "#879aff",
        editorTextFont: "10pt Monaco, Lucida Console, monospace",
        editorSelectedTextColor: "rgb(240, 240, 240)",
        editorSelectedTextBackground: "#526da5",
        unfocusedCursorStrokeStyle: "#ff0033",
        unfocusedCursorFillStyle: "#73171e"
    },

    /**
     * Deletes the selection or the previous character, if the selection is an
     * insertion point.
     */
    backspace: function() {
        this._beginChangeGroup();

        var textStorage = this.getPath('layoutManager.textStorage');

        // If the selection is an insertion point, extend it back by one
        // character.
        var ranges = this._selectedRanges;
        if (this._rangeSetIsInsertionPoint(ranges)) {
            var range = ranges[0];
            ranges = [
                {
                    start:  textStorage.displacePosition(range.start, -1),
                    end:    range.end
                }
            ];
        }

        ranges.forEach(function(range) {
            this._replaceCharacters(range, "");
        }, this);

        // Position the insertion point at the start of all the ranges that
        // were just deleted.
        this._reanchorSelection(ranges[0].start);

        this._endChangeGroup();
    },

    /**
     * This is where the editor is painted from head to toe. Pitiful tricks are
     * used to draw as little as possible.
     */
    drawRect: function(rect, context) {
        context.fillStyle = this.get('theme').backgroundStyle;
        context.fillRect(rect.x, rect.y, rect.width, rect.height);

        this._drawSelection(rect, context);
        this._drawLines(rect, context);
    },

    init: function() {
        arguments.callee.base.apply(this, arguments);

        this._invalidRange = null;
        this._selectedRanges =
            [ { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } } ];

        // Allow the user to change the fields of the padding object without
        // screwing up the prototype.
        this.set('padding', SC.clone(this.get('padding')));

        this.get('layoutManager').addDelegate(this);

        this._resize();
    },

    keyDown: function(evt) {
        return keyboardManager.processKeyEvent(evt, this, { isTextView: true });
    },

    /**
     * The layout manager calls this method to signal to the view that the text
     * and/or layout has changed.
     */
    layoutManagerInvalidatedRects: function(sender, rects) {
        rects.forEach(this.setNeedsDisplayInRect, this);
        this._repositionSelection();
        this._resize();
    },

    mouseDown: function(evt) {
        this._reanchorSelection(this._selectionPositionForPoint(this.
            convertFrameFromView({ x: evt.clientX, y: evt.clientY })));
        this._virtualInsertionPoint = null;

        this._dragPoint = { x: evt.clientX, y: evt.clientY };
        this._dragTimer = SC.Timer.schedule({
            target:     this,
            action:     '_scrollWhileDragging',
            interval:   100,
            repeats:    true
        });

        this.becomeFirstResponder();
    },

    mouseDragged: function(evt) {
        this._dragPoint = { x: evt.clientX, y: evt.clientY };
        this._drag();
    },

    mouseUp: function(evt) {
        if (this._dragTimer !== null) {
            this._dragTimer.invalidate();
        }
    },

    moveDown: function() {
        var ranges = this._selectedRanges;
        var position;
        if (this._rangeSetIsInsertionPoint(ranges)) {
            position = this._getVirtualInsertionPoint();
        } else {
            // Yes, this is actually what Cocoa does... weird, huh?
            var range = ranges[0];
            position = { row: range.end.row, column: range.start.column };
        }
        position = Range.addPositions(position, { row: 1, column: 0 });

        this._reanchorSelection(this.getPath('layoutManager.textStorage').
            clampPosition(position));
        this._virtualInsertionPoint = position;
    },

    moveLeft: function() {
        var ranges = this._selectedRanges;
        if (this._rangeSetIsInsertionPoint(ranges)) {
            this._reanchorSelection(this.getPath('layoutManager.textStorage').
                displacePosition(ranges[0].start, -1));
            this._virtualInsertionPoint = null;
        } else {
            this._reanchorSelection(ranges[0].start);
        }
    },

    moveRight: function() {
        var ranges = this._selectedRanges;
        if (this._rangeSetIsInsertionPoint(ranges)) {
            this._reanchorSelection(this.getPath('layoutManager.textStorage').
                displacePosition(ranges[ranges.length - 1].end, 1));
            this._virtualInsertionPoint = null;
        } else {
            this._reanchorSelection(ranges[0].end);
        }
    },

    moveUp: function() {
        var ranges = this._selectedRanges;
        var position = this._rangeSetIsInsertionPoint(ranges) ?
            this._getVirtualInsertionPoint() : ranges[0].start;
        position = Range.addPositions(position, { row: -1, column: 0 });

        this._reanchorSelection(this.getPath('layoutManager.textStorage').
            clampPosition(position));
        this._virtualInsertionPoint = position;
    },

    /**
     * Inserts a newline at the insertion point.
     */
    newline: function() {
        // Insert a newline, and copy the spaces at the beginning of the
        // current row to autoindent.
        var position = this._selectedRanges[0].start;
        this._beginChangeGroup();
        this._insertText("\n" + /^\s*/.exec(this.
            getPath('layoutManager.textStorage.lines')[position.row].
            substring(0, position.column))[0]);
        this._endChangeGroup();
    },

    selectDown: function() {
        this._performVerticalKeyboardSelection(1);
    },

    selectLeft: function() {
        this._extendSelectionFromStandardOrigin(this.
            getPath('layoutManager.textStorage').
            displacePosition(this._selectionTail(), -1));
        this._virtualInsertionPoint = null;
    },

    selectRight: function() {
        this._extendSelectionFromStandardOrigin(this.
            getPath('layoutManager.textStorage').
            displacePosition(this._selectionTail(), 1));
        this._virtualInsertionPoint = null;
    },

    selectUp: function() {
        this._performVerticalKeyboardSelection(-1);
    },

    /**
     * Directly replaces the current selection with a new one. No bounds
     * checking is performed, and the user is not able to undo this action.
     */
    setSelection: function(newRanges) {
        var oldRanges = this._selectedRanges;
        this._selectedRanges = newRanges;

        var layoutManager = this.get('layoutManager');
        oldRanges.concat(newRanges).forEach(function(range) {
            layoutManager.rectsForRange(range).
                forEach(this.setNeedsDisplayInRect, this);
        }, this);

        // Also invalidate any insertion points. These have to be handled
        // separately, because they're drawn outside of their associated
        // character regions.
        this._invalidateInsertionPointIfNecessary(oldRanges);
        this._invalidateInsertionPointIfNecessary(newRanges);
    },

    tab: function() {
        this._beginChangeGroup();
        this._insertText("        ".substring(0, 8 -
            this._selectedRanges[0].start.column % 8));
        this._endChangeGroup();
    },

    textInserted: function(text) {
        this._beginChangeGroup();
        this._insertText(text);
        this._endChangeGroup();
    }
});
