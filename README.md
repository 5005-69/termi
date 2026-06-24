# termi

Ένας προσωπικός terminal manager (Electron) με δυναμικά split layouts, file explorer,
Monaco editor, source control και **remote πρόσβαση από κινητό** μέσω Cloudflare tunnel.

## Εγκατάσταση

```bash
git clone https://github.com/5005-69/termi.git
cd termi
npm install
npm start
```

> Χρειάζεται [Node.js](https://nodejs.org/) (LTS). Στα Windows το `npm install` χτίζει
> το `node-pty` — αν χρειαστεί, εγκατέστησε τα Visual Studio Build Tools (C++).

## Χρήση

- **Split panes:** σύρε ένα pane από τη μπάρα του και ρίξ' το αριστερά/δεξιά/πάνω/κάτω
  ενός άλλου για split, ή στο κέντρο για swap.
- **File explorer:** άνοιξε φάκελο, κλικ σε αρχείο για άνοιγμα στον editor.
  Τα αρχεία ανοίγουν στο ίδιο (ξεκλείδωτο) pane· πάτα την 🔒 κλειδαριά για να το
  «καρφιτσώσεις» ώστε το επόμενο αρχείο να ανοίξει σε νέο pane.
- **Terminals:** πραγματικά shells (node-pty), per-pane φάκελος εργασίας, command launchers.

## Remote πρόσβαση από κινητό (η «πόρτα»)

Άνοιξε την πόρτα ώστε να φορτώσεις ΟΛΗ την εφαρμογή στον browser του κινητού σου,
ενώ terminals/αρχεία/git τρέχουν στον υπολογιστή:

```bash
npm run door            # πλήρης έλεγχος
npm run door -- -r      # μόνο ανάγνωση (read-only)
```

Εμφανίζεται **QR + PIN** στο τερματικό. Σκάναρε το QR με το κινητό, γράψε το PIN.

### Το PIN

Το PIN ορίζεται με την εξής σειρά προτεραιότητας:

1. Μεταβλητή περιβάλλοντος `TERMI_PIN`
2. Αρχείο `remote/.pin` (τοπικό, **δεν** ανεβαίνει στο git)
3. Διαφορετικά παράγεται **τυχαίος** κωδικός κάθε φορά

Για σταθερό δικό σου κωδικό:

```bash
cp remote/.pin.example remote/.pin   # και βάλε μέσα τον 6ψήφιο κωδικό σου
```

## Build (Windows installer)

```bash
npm run dist     # -> release/termi Setup x.y.z.exe
```
