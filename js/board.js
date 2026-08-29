// board.js
//
// Renders an 8x8 board as SVG from a chess.js (0.10.x API) instance. No
// external board library: this console needs full control over styling and
// there's nothing here dragboard.js-style libraries do that we need (moves
// are made by the engine, not by dragging pieces).

// Fallback glyphs, used only if a piece image fails to load (e.g. the
// assets/pieces/ folder is missing or a file 404s).
const GLYPH = {
  p: '\u265F', n: '\u265E', b: '\u265D', r: '\u265C', q: '\u265B', k: '\u265A', // black (filled)
};
const GLYPH_WHITE = {
  p: '\u2659', n: '\u2658', b: '\u2657', r: '\u2656', q: '\u2655', k: '\u2654',
};

// Piece SVGs live at assets/pieces/{w|b}{P,N,B,R,Q,K}.svg, resolved relative
// to index.html (this module's own URL doesn't matter for <image href>).
const PIECE_ASSET_DIR = 'assets/pieces/';

function pieceAssetUrl(piece) {
  return `${PIECE_ASSET_DIR}${piece.color}${piece.type.toUpperCase()}.svg`;
}

const SQ = 48; // px per square
const PAD = 22; // px for coordinate labels

export function createBoardSvg(container) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${SQ * 8 + PAD * 2} ${SQ * 8 + PAD * 2}`);
  svg.setAttribute('class', 'board-svg');
  container.appendChild(svg);
  return svg;
}

function squareCenter(file, rank, orientation) {
  // file, rank are 0-7 with file=0 -> 'a', rank=0 -> '1'
  const dispFile = orientation === 'white' ? file : 7 - file;
  const dispRank = orientation === 'white' ? 7 - rank : rank;
  return {
    x: PAD + dispFile * SQ + SQ / 2,
    y: PAD + dispRank * SQ + SQ / 2,
  };
}

/**
 * Render the board.
 * @param svg the <svg> created by createBoardSvg
 * @param chess a chess.js instance (source of truth for piece placement)
 * @param opts { orientation: 'white'|'black', lastMove: {from,to}|null }
 */
// Parse the piece-placement field of a FEN string into board[rank][file],
// rank 0 = rank 1 ... rank 7 = rank 8, file 0 = 'a' ... file 7 = 'h'.
// Parsed from FEN directly (rather than a library's board() accessor) so
// this renderer only depends on chess.fen(), which every chess.js version
// exposes identically.
function boardFromFen(fen) {
  const placement = fen.split(' ')[0];
  const rows = placement.split('/'); // rows[0] = rank 8 ... rows[7] = rank 1
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 8; r++) {
    const rank = 7 - r; // rows[0] -> rank index 7 (rank 8)
    let file = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        file += Number(ch);
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        board[rank][file] = { type: ch.toLowerCase(), color };
        file++;
      }
    }
  }
  return board;
}

export function renderBoard(svg, chess, opts = {}) {
  const orientation = opts.orientation || 'white';
  const lastMove = opts.lastMove || null;
  svg.innerHTML = '';

  const ns = 'http://www.w3.org/2000/svg';
  const boardG = document.createElementNS(ns, 'g');
  svg.appendChild(boardG);

  const inCheck = chess.in_check ? chess.in_check() : false;
  const turn = chess.turn ? chess.turn() : 'w';
  const board = boardFromFen(chess.fen());

  let kingSquareFile = -1, kingSquareRank = -1;

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const dispFile = orientation === 'white' ? file : 7 - file;
      const dispRank = orientation === 'white' ? 7 - rank : rank;
      const x = PAD + dispFile * SQ;
      const y = PAD + dispRank * SQ;
      const isLight = (file + rank) % 2 === 1;

      const sq = document.createElementNS(ns, 'rect');
      sq.setAttribute('x', x);
      sq.setAttribute('y', y);
      sq.setAttribute('width', SQ);
      sq.setAttribute('height', SQ);
      sq.setAttribute('class', isLight ? 'sq-light' : 'sq-dark');
      boardG.appendChild(sq);

      const squareName = 'abcdefgh'[file] + (rank + 1);
      if (lastMove && (squareName === lastMove.from || squareName === lastMove.to)) {
        const hl = document.createElementNS(ns, 'rect');
        hl.setAttribute('x', x);
        hl.setAttribute('y', y);
        hl.setAttribute('width', SQ);
        hl.setAttribute('height', SQ);
        hl.setAttribute('class', 'sq-lastmove');
        boardG.appendChild(hl);
      }

      const piece = board[rank][file];
      if (piece) {
        if (piece.type === 'k' && piece.color === turn[0]) {
          kingSquareFile = file;
          kingSquareRank = rank;
        }

        // Small inset so the piece doesn't touch the square edges.
        const inset = SQ * 0.06;
        const img = document.createElementNS(ns, 'image');
        const href = pieceAssetUrl(piece);
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
        img.setAttribute('href', href);
        img.setAttribute('x', x + inset);
        img.setAttribute('y', y + inset);
        img.setAttribute('width', SQ - inset * 2);
        img.setAttribute('height', SQ - inset * 2);
        img.setAttribute('class', 'piece-image');
        img.setAttribute('draggable', 'false');

        // If the SVG asset is missing/404s, fall back to the unicode glyph
        // instead of leaving the square silently blank.
        img.addEventListener('error', () => {
          if (img.parentNode !== boardG) return; // already replaced
          const glyph = piece.color === 'w' ? GLYPH_WHITE[piece.type] : GLYPH[piece.type];
          const text = document.createElementNS(ns, 'text');
          text.setAttribute('x', x + SQ / 2);
          text.setAttribute('y', y + SQ / 2 + 1);
          text.setAttribute('class', 'piece-glyph');
          text.textContent = glyph;
          boardG.replaceChild(text, img);
        }, { once: true });

        boardG.appendChild(img);
      }
    }
  }

  if (inCheck && kingSquareFile !== -1) {
    const c = squareCenter(kingSquareFile, kingSquareRank, orientation);
    const ring = document.createElementNS(ns, 'circle');
    ring.setAttribute('cx', c.x);
    ring.setAttribute('cy', c.y);
    ring.setAttribute('r', SQ / 2 - 3);
    ring.setAttribute('class', 'check-ring');
    boardG.appendChild(ring);
  }

  // Coordinate labels
  for (let i = 0; i < 8; i++) {
    const fileChar = 'abcdefgh'[orientation === 'white' ? i : 7 - i];
    const rankChar = String(orientation === 'white' ? 8 - i : i + 1);

    const fLabel = document.createElementNS(ns, 'text');
    fLabel.setAttribute('x', PAD + i * SQ + SQ / 2);
    fLabel.setAttribute('y', PAD + 8 * SQ + 14);
    fLabel.setAttribute('class', 'coord-label');
    fLabel.textContent = fileChar;
    svg.appendChild(fLabel);

    const rLabel = document.createElementNS(ns, 'text');
    rLabel.setAttribute('x', 10);
    rLabel.setAttribute('y', PAD + i * SQ + SQ / 2 + 4);
    rLabel.setAttribute('class', 'coord-label');
    rLabel.textContent = rankChar;
    svg.appendChild(rLabel);
  }
}
