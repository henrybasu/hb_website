(function () {
  "use strict";

  var gridEl = document.getElementById("sudoku-grid");
  if (!gridEl) {
    return;
  }

  var statusEl = document.getElementById("sudoku-status");
  var difficultyEl = document.getElementById("sudoku-difficulty");
  var newBtn = document.getElementById("sudoku-new");
  var checkBtn = document.getElementById("sudoku-check");
  var clearBtn = document.getElementById("sudoku-clear");
  var undoBtn = document.getElementById("sudoku-undo");
  var hintBtn = document.getElementById("sudoku-hint-btn");
  var penBtn = document.getElementById("sudoku-pen");
  var notesBtn = document.getElementById("sudoku-notes");
  var numpadEl = document.getElementById("sudoku-numpad");
  var timerEl = document.getElementById("sudoku-timer");
  var mistakesEl = document.getElementById("sudoku-mistakes");
  var remainingEl = document.getElementById("sudoku-remaining");
  var hintsEl = document.getElementById("sudoku-hints");
  var modeLabelEl = document.getElementById("sudoku-mode-label");
  var winEl = document.getElementById("sudoku-win");
  var winDetailEl = document.getElementById("sudoku-win-detail");
  var winNewBtn = document.getElementById("sudoku-win-new");

  var CLUES = { easy: 38, medium: 32, hard: 26 };
  var MAX_MISTAKES = 3;
  var MAX_HINTS = 3;

  var board = createEmptyBoard();
  var solution = createEmptyBoard();
  var fixed = createEmptyBoard();
  var notes = createNotesBoard();
  var selected = null;
  var gameWon = false;
  var gameOver = false;
  var notesMode = false;
  var mistakes = 0;
  var hintsLeft = MAX_HINTS;
  var seconds = 0;
  var timerId = 0;
  var history = [];

  function createEmptyBoard() {
    var b = [];
    var r;
    var c;
    for (r = 0; r < 9; r++) {
      b[r] = [];
      for (c = 0; c < 9; c++) {
        b[r][c] = 0;
      }
    }
    return b;
  }

  function createNotesBoard() {
    var n = [];
    var r;
    var c;
    for (r = 0; r < 9; r++) {
      n[r] = [];
      for (c = 0; c < 9; c++) {
        n[r][c] = [false, false, false, false, false, false, false, false, false, false];
      }
    }
    return n;
  }

  function copyBoard(src) {
    return src.map(function (row) {
      return row.slice();
    });
  }

  function copyNotes(src) {
    return src.map(function (row) {
      return row.map(function (cell) {
        return cell.slice();
      });
    });
  }

  function shuffle(arr) {
    var a = arr.slice();
    var i;
    var j;
    var tmp;
    for (i = a.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  function isValid(board, row, col, num) {
    var r;
    var c;
    var br = Math.floor(row / 3) * 3;
    var bc = Math.floor(col / 3) * 3;

    for (c = 0; c < 9; c++) {
      if (board[row][c] === num) {
        return false;
      }
    }
    for (r = 0; r < 9; r++) {
      if (board[r][col] === num) {
        return false;
      }
    }
    for (r = 0; r < 3; r++) {
      for (c = 0; c < 3; c++) {
        if (board[br + r][bc + c] === num) {
          return false;
        }
      }
    }
    return true;
  }

  function solve(board) {
    var row;
    var col;
    var nums;
    var i;
    var n;

    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        if (board[row][col] === 0) {
          nums = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
          for (i = 0; i < 9; i++) {
            n = nums[i];
            if (isValid(board, row, col, n)) {
              board[row][col] = n;
              if (solve(board)) {
                return true;
              }
              board[row][col] = 0;
            }
          }
          return false;
        }
      }
    }
    return true;
  }

  function generatePuzzle(clueCount) {
    var empty = createEmptyBoard();
    var positions = [];
    var i;
    var pos;
    var row;
    var col;

    solve(empty);
    solution = copyBoard(empty);
    board = copyBoard(empty);
    notes = createNotesBoard();

    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        positions.push(row * 9 + col);
      }
    }
    positions = shuffle(positions);

    for (i = 0; i < 81 - clueCount && i < positions.length; i++) {
      pos = positions[i];
      row = Math.floor(pos / 9);
      col = pos % 9;
      board[row][col] = 0;
    }

    fixed = createEmptyBoard();
    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        fixed[row][col] = board[row][col] !== 0;
      }
    }
  }

  function setStatus(message, type) {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = message;
    statusEl.className = "sudoku-status" + (type ? " sudoku-status--" + type : "");
  }

  function formatTime(total) {
    var mins = Math.floor(total / 60);
    var secs = total % 60;
    return (mins < 10 ? "0" : "") + mins + ":" + (secs < 10 ? "0" : "") + secs;
  }

  function startTimer() {
    stopTimer();
    seconds = 0;
    if (timerEl) {
      timerEl.textContent = "00:00";
    }
    timerId = window.setInterval(function () {
      if (!gameWon && !gameOver) {
        seconds += 1;
        if (timerEl) {
          timerEl.textContent = formatTime(seconds);
        }
      }
    }, 1000);
  }

  function stopTimer() {
    if (timerId) {
      window.clearInterval(timerId);
      timerId = 0;
    }
  }

  function updateStats() {
    if (mistakesEl) {
      mistakesEl.textContent = mistakes + " / " + MAX_MISTAKES;
    }
    if (remainingEl) {
      remainingEl.textContent = String(countEmpty());
    }
    if (hintsEl) {
      hintsEl.textContent = hintsLeft + " left";
    }
    if (modeLabelEl) {
      modeLabelEl.textContent = notesMode ? "Notes" : "Pen";
    }
    updateNumpadCounts();
  }

  function countEmpty() {
    var row;
    var col;
    var count = 0;
    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        if (board[row][col] === 0) {
          count += 1;
        }
      }
    }
    return count;
  }

  function digitCounts() {
    var counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var row;
    var col;
    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        if (board[row][col] > 0) {
          counts[board[row][col]] += 1;
        }
      }
    }
    return counts;
  }

  function updateNumpadCounts() {
    if (!numpadEl) {
      return;
    }
    var counts = digitCounts();
    var n;
    var btn;
    var left;
    for (n = 1; n <= 9; n++) {
      btn = numpadEl.querySelector('[data-value="' + n + '"]');
      if (!btn) {
        continue;
      }
      left = 9 - counts[n];
      btn.querySelector(".sudoku-numpad-count").textContent = String(left);
      btn.classList.toggle("is-exhausted", left === 0);
    }
  }

  function cellIndex(row, col) {
    return row * 9 + col;
  }

  function hasNotes(row, col) {
    var n;
    for (n = 1; n <= 9; n++) {
      if (notes[row][col][n]) {
        return true;
      }
    }
    return false;
  }

  function clearNotes(row, col) {
    var n;
    for (n = 1; n <= 9; n++) {
      notes[row][col][n] = false;
    }
  }

  function getConflicts() {
    var conflicts = {};
    var row;
    var col;
    var r;
    var c;
    var num;
    var key;
    var br;
    var bc;

    function mark(r, c) {
      conflicts[r + "," + c] = true;
    }

    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        num = board[row][col];
        if (num === 0) {
          continue;
        }
        for (c = 0; c < 9; c++) {
          if (c !== col && board[row][c] === num) {
            mark(row, col);
            mark(row, c);
          }
        }
        for (r = 0; r < 9; r++) {
          if (r !== row && board[r][col] === num) {
            mark(row, col);
            mark(r, col);
          }
        }
        br = Math.floor(row / 3) * 3;
        bc = Math.floor(col / 3) * 3;
        for (r = 0; r < 3; r++) {
          for (c = 0; c < 3; c++) {
            key = br + r + "," + (bc + c);
            if ((br + r !== row || bc + c !== col) && board[br + r][bc + c] === num) {
              mark(row, col);
              mark(br + r, bc + c);
            }
          }
        }
      }
    }
    return conflicts;
  }

  function renderCellContent(cell, row, col, value) {
    var n;
    var notesEl;
    var span;

    cell.textContent = "";
    if (value > 0) {
      cell.textContent = String(value);
      return;
    }
    if (!hasNotes(row, col)) {
      return;
    }
    notesEl = document.createElement("div");
    notesEl.className = "sudoku-notes";
    for (n = 1; n <= 9; n++) {
      span = document.createElement("span");
      if (notes[row][col][n]) {
        span.textContent = String(n);
      }
      notesEl.appendChild(span);
    }
    cell.appendChild(notesEl);
  }

  function render() {
    var row;
    var col;
    var idx;
    var value;
    var cell;
    var selectedValue = 0;
    var conflicts = getConflicts();

    if (selected) {
      selectedValue = board[selected.row][selected.col];
    }

    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        idx = cellIndex(row, col);
        value = board[row][col];
        cell = gridEl.children[idx];

        renderCellContent(cell, row, col, value);
        cell.className = "sudoku-cell";
        cell.setAttribute("aria-selected", "false");

        if (fixed[row][col]) {
          cell.classList.add("fixed");
        }
        if (conflicts[row + "," + col]) {
          cell.classList.add("conflict");
        }
        if (selected && selected.row === row && selected.col === col) {
          cell.classList.add("selected");
          cell.setAttribute("aria-selected", "true");
        } else if (
          selected &&
          (selected.row === row ||
            selected.col === col ||
            (Math.floor(selected.row / 3) === Math.floor(row / 3) &&
              Math.floor(selected.col / 3) === Math.floor(col / 3)))
        ) {
          cell.classList.add("highlight");
        }
        if (selectedValue > 0 && value === selectedValue) {
          cell.classList.add("same-number");
        }
      }
    }
    updateStats();
  }

  function buildGrid() {
    var row;
    var col;
    var cell;

    gridEl.innerHTML = "";
    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        cell = document.createElement("button");
        cell.type = "button";
        cell.className = "sudoku-cell";
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("aria-label", "Row " + (row + 1) + ", column " + (col + 1));
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        cell.addEventListener("click", function (event) {
          selectCell(
            Number(event.currentTarget.dataset.row),
            Number(event.currentTarget.dataset.col)
          );
        });
        gridEl.appendChild(cell);
      }
    }
  }

  function buildNumpad() {
    var n;
    var btn;
    var count;

    if (!numpadEl) {
      return;
    }

    numpadEl.innerHTML = "";
    for (n = 1; n <= 9; n++) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sudoku-numpad-btn";
      btn.dataset.value = String(n);
      btn.innerHTML = "<span class=\"sudoku-numpad-digit\">" + n + "</span><span class=\"sudoku-numpad-count\">9</span>";
      btn.addEventListener("click", function (event) {
        placeNumber(Number(event.currentTarget.dataset.value));
      });
      numpadEl.appendChild(btn);
    }
  }

  function pushHistory() {
    history.push({
      board: copyBoard(board),
      notes: copyNotes(notes)
    });
    if (history.length > 40) {
      history.shift();
    }
  }

  function selectCell(row, col) {
    if (gameWon || gameOver) {
      return;
    }
    selected = { row: row, col: col };
    render();
  }

  function setNotesMode(enabled) {
    notesMode = enabled;
    if (penBtn) {
      penBtn.classList.toggle("is-active", !enabled);
      penBtn.setAttribute("aria-pressed", String(!enabled));
    }
    if (notesBtn) {
      notesBtn.classList.toggle("is-active", enabled);
      notesBtn.setAttribute("aria-pressed", String(enabled));
    }
    updateStats();
  }

  function removeNumberFromPeers(num, row, col) {
    var r;
    var c;
    var br = Math.floor(row / 3) * 3;
    var bc = Math.floor(col / 3) * 3;

    for (c = 0; c < 9; c++) {
      notes[row][c][num] = false;
    }
    for (r = 0; r < 9; r++) {
      notes[r][col][num] = false;
    }
    for (r = 0; r < 3; r++) {
      for (c = 0; c < 3; c++) {
        notes[br + r][bc + c][num] = false;
      }
    }
  }

  function placeNumber(num) {
    if (!selected || gameWon || gameOver || fixed[selected.row][selected.col]) {
      return;
    }

    pushHistory();
    var row = selected.row;
    var col = selected.col;

    if (notesMode) {
      if (board[row][col] === 0) {
        notes[row][col][num] = !notes[row][col][num];
        render();
        setStatus("Toggled note " + num + " in row " + (row + 1) + ", column " + (col + 1) + ".", "playing");
      }
      return;
    }

    board[row][col] = num;
    clearNotes(row, col);
    removeNumberFromPeers(num, row, col);

    if (board[row][col] !== solution[row][col]) {
      mistakes += 1;
      if (mistakes >= MAX_MISTAKES) {
        gameOver = true;
        setStatus("Three mistakes — puzzle over. Start a new game.", "error");
      } else {
        setStatus("That number doesn't fit here. Mistake " + mistakes + " of " + MAX_MISTAKES + ".", "error");
      }
    } else if (isComplete()) {
      winGame();
      return;
    } else {
      setStatus("Placed " + num + ". " + countEmpty() + " cells remaining.", "playing");
    }

    render();
  }

  function clearSelectedCell() {
    if (!selected || gameWon || gameOver || fixed[selected.row][selected.col]) {
      return;
    }
    if (board[selected.row][selected.col] === 0 && !hasNotes(selected.row, selected.col)) {
      return;
    }
    pushHistory();
    board[selected.row][selected.col] = 0;
    clearNotes(selected.row, selected.col);
    render();
    setStatus("Cell erased.", "playing");
  }

  function undoMove() {
    if (!history.length || gameWon) {
      return;
    }
    var prev = history.pop();
    board = prev.board;
    notes = prev.notes;
    render();
    setStatus("Undid last move.", "playing");
  }

  function useHint() {
    var empties = [];
    var row;
    var col;
    var pick;
    var r;
    var c;

    if (gameWon || gameOver || hintsLeft <= 0) {
      return;
    }

    if (selected && board[selected.row][selected.col] === 0) {
      r = selected.row;
      c = selected.col;
    } else {
      for (row = 0; row < 9; row++) {
        for (col = 0; col < 9; col++) {
          if (board[row][col] === 0) {
            empties.push({ row: row, col: col });
          }
        }
      }
      if (!empties.length) {
        return;
      }
      pick = empties[Math.floor(Math.random() * empties.length)];
      r = pick.row;
      c = pick.col;
    }

    pushHistory();
    board[r][c] = solution[r][c];
    clearNotes(r, c);
    removeNumberFromPeers(solution[r][c], r, c);
    hintsLeft -= 1;
    selected = { row: r, col: c };

    if (isComplete()) {
      winGame();
      return;
    }

    render();
    setStatus("Hint revealed row " + (r + 1) + ", column " + (c + 1) + ". " + hintsLeft + " hints left.", "playing");
  }

  function isComplete() {
    var row;
    var col;
    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        if (board[row][col] === 0) {
          return false;
        }
      }
    }
    return true;
  }

  function isCorrect() {
    var row;
    var col;
    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        if (board[row][col] !== solution[row][col]) {
          return false;
        }
      }
    }
    return true;
  }

  function winGame() {
    gameWon = true;
    stopTimer();
    setStatus("Puzzle complete in " + formatTime(seconds) + "!", "win");
    if (winEl) {
      winEl.hidden = false;
    }
    if (winDetailEl) {
      winDetailEl.textContent =
        "Time: " + formatTime(seconds) +
        " · Mistakes: " + mistakes +
        " · Hints used: " + (MAX_HINTS - hintsLeft);
    }
    render();
  }

  function checkBoard() {
    var row;
    var col;
    var wrong = 0;

    if (gameWon || gameOver) {
      return;
    }

    for (row = 0; row < 9; row++) {
      for (col = 0; col < 9; col++) {
        if (board[row][col] !== 0 && board[row][col] !== solution[row][col]) {
          wrong += 1;
        }
      }
    }

    if (isComplete() && wrong === 0) {
      winGame();
    } else if (wrong > 0) {
      setStatus(wrong + " cell" + (wrong === 1 ? "" : "s") + " disagree with the solution.", "error");
    } else if (Object.keys(getConflicts()).length > 0) {
      setStatus("No solution errors yet, but some rows or boxes have duplicates.", "error");
    } else {
      setStatus("Looking good so far. " + countEmpty() + " cells left to fill.", "playing");
    }
    render();
  }

  function newGame() {
    var difficulty = difficultyEl ? difficultyEl.value : "medium";
    var clues = CLUES[difficulty] || CLUES.medium;

    gameWon = false;
    gameOver = false;
    mistakes = 0;
    hintsLeft = MAX_HINTS;
    history = [];
    selected = null;
    setNotesMode(false);

    if (winEl) {
      winEl.hidden = true;
    }

    generatePuzzle(clues);
    render();
    startTimer();
    setStatus("New " + difficulty + " puzzle — " + countEmpty() + " cells to fill.", "playing");
  }

  function onKeyDown(event) {
    var key = event.key;

    if (gameWon) {
      return;
    }

    if (key === "n" || key === "N") {
      event.preventDefault();
      setNotesMode(!notesMode);
      return;
    }

    if (key === "h" || key === "H") {
      event.preventDefault();
      useHint();
      return;
    }

    if (key === "z" || key === "Z") {
      event.preventDefault();
      undoMove();
      return;
    }

    if (!selected) {
      return;
    }

    if (key >= "1" && key <= "9") {
      event.preventDefault();
      placeNumber(Number(key));
      return;
    }

    if (key === "Backspace" || key === "Delete" || key === "0") {
      event.preventDefault();
      clearSelectedCell();
      return;
    }

    if (key === "ArrowUp" && selected.row > 0) {
      event.preventDefault();
      selectCell(selected.row - 1, selected.col);
    } else if (key === "ArrowDown" && selected.row < 8) {
      event.preventDefault();
      selectCell(selected.row + 1, selected.col);
    } else if (key === "ArrowLeft" && selected.col > 0) {
      event.preventDefault();
      selectCell(selected.row, selected.col - 1);
    } else if (key === "ArrowRight" && selected.col < 8) {
      event.preventDefault();
      selectCell(selected.row, selected.col + 1);
    }
  }

  buildGrid();
  buildNumpad();
  newGame();

  if (newBtn) {
    newBtn.addEventListener("click", newGame);
  }
  if (winNewBtn) {
    winNewBtn.addEventListener("click", newGame);
  }
  if (checkBtn) {
    checkBtn.addEventListener("click", checkBoard);
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", clearSelectedCell);
  }
  if (undoBtn) {
    undoBtn.addEventListener("click", undoMove);
  }
  if (hintBtn) {
    hintBtn.addEventListener("click", useHint);
  }
  if (penBtn) {
    penBtn.addEventListener("click", function () {
      setNotesMode(false);
    });
  }
  if (notesBtn) {
    notesBtn.addEventListener("click", function () {
      setNotesMode(true);
    });
  }

  document.addEventListener("keydown", onKeyDown);

  window.addEventListener("beforeunload", function () {
    stopTimer();
  });
})();
