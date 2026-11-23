# Sample files for the README walkthrough

**FICTIONAL / ILLUSTRATIVE.** Willowbank Veterinary Group, its quote references, items and prices are made up for the screenshots in the [walkthrough](../../docs/walkthrough.md) (linked from the [README](../../README.md#your-first-walkthrough-with-screenshots)). They are not real customers, quotes or prices, and they are not output of the product.

These are the exact files used for those screenshots. You can use them to repeat the walkthrough on your own machine.

| File | Used in | What it is |
|------|---------|------------|
| [01-usd/Willowbank-Quote-2027-01.md](01-usd/Willowbank-Quote-2027-01.md) | Start new, step 2 | First quote, priced in **USD** (total USD 5,700.00). Becomes version 1. |
| [02-sgd-corrected/Willowbank-Quote-2027-01.md](02-sgd-corrected/Willowbank-Quote-2027-01.md) | Import existing | The same quote corrected to **SGD** (total SGD 7,600.00). Same file name on purpose, so importing it adds **version 2** instead of a new document. |
| [Willowbank-Addendum-2027-02.md](Willowbank-Addendum-2027-02.md) | Import existing | A separate addendum in SGD (SGD 280.00). Imported as a new document. |
| [willowbank-price-list-2027.csv](willowbank-price-list-2027.csv) | Import existing, price lists (CSV) | A three-row price list. Key column `item_code`, value column `unit_price`. |

The two quote files have the same name and sit in separate folders so that you can choose each one from a file picker without renaming it.

These files are not design fixtures and have no proposed schema. `tools/check_repo.py` does not validate them.
