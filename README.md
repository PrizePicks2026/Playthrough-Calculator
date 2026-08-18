# Playthrough Calculator

A browser-based tool for checking a member's playthrough requirement status from a pasted transaction history. It calculates how much of the required 1x playthrough has been met, flags withdrawals that occurred before playthrough cleared, and generates a ready-to-send spiel for member support.

## Folder Structure

```
Playthrough Calculator/
├── index.html
├── css/
│   └── style.css
└── js/
    └── script.js
```

## How to Use

1. Open `index.html` in any modern web browser (double-click the file, or right-click → Open With → your browser).
2. Paste the member's transaction history into the input box.
3. Optionally enter the member's name to personalize the generated spiel.
4. Click Calculate to see:
   - Overall playthrough progress (ring + stats)
   - A per-deposit breakdown table
   - Any withdrawals flagged as occurring before playthrough cleared
   - A copy-ready spiel to send to the member

## Notes

- This tool runs entirely in the browser — no data is sent anywhere or stored.
- Keep `index.html`, the `css` folder, and the `js` folder together in the same parent folder, or the styling and functionality will break.
- No installation or internet connection required after the files are downloaded (aside from loading the Google Fonts used for styling).

## License

See `LICENSE.txt` (MIT License).
