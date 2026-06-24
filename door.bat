@echo off
REM Διπλό-κλικ για να ανοίξει η πόρτα του termi (QR + PIN στο παράθυρο).
REM Πρόσθεσε --read-only μετά το cli.js αν θες μόνο ανάγνωση.
cd /d "%~dp0"
node remote\cli.js %*
pause
