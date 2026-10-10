# Store screenshots: the shot list

Five screenshots for the Chrome Web Store listing, taken by the owner on a real dealership website and the real Marketplace form, with that dealership's OK. The drafts in `site/screenshots/` come from the sandbox and never go to the store. `store/listing.md` (Screenshots) has the table of what each one shows and its caption; this page is how to take them.

## Before you start

- Chrome with the packed build loaded (`npm run pack`, then load the unzipped folder at `chrome://extensions` with Developer mode on), signed in to your own Facebook account.
- A dealership website the extension reads, whose manager has said yes to its cars appearing in the store images.
- Nothing personal may stay visible: cover your name and profile picture, the Facebook account menu, the listing's address line if it shows a home address, any customer name or message, and any other salesperson's name. Your dealership's name and the car's facts can stay; they are what the listing is about.
- No Facebook or Meta logo, wordmark or brand colour in any store image, the real form's included (`legal/trademark-note.md`): crop each capture of a Facebook page below Facebook's top bar, and cover with a solid filled box any Facebook logo or wordmark and any button or mark in Facebook's blue that is still in the frame. No arrows, badges, stars, "approved", "safe" or numbers drawn on top.

## Taking each shot

Make the Chrome window large enough that the page plus the popup or side panel fill it, then capture the window (on Windows: Win + Shift + S, Window mode; or the Snipping Tool). Cover anything personal, and Facebook's logo, wordmark and blue (above), with a solid filled box in Paint (a light blur can sometimes be read back) before saving. Save each capture as PNG into `store/screenshots/raw/`, named so they sort in order:

| File | Shot | How to get there |
|---|---|---|
| `1-ready.png` | The popup's **Ready to post** tab after a scan | On the dealership's used-inventory page, click the toolbar icon, then **Scan website**. Leave the popup open while capturing. |
| `2-review.png` | The side panel's review screen | Click **Post** on a car with a full set of photos. Wait for the re-check and the description. |
| `3-form.png` | The Marketplace form filled in, Publish untouched | Click **Open the Marketplace form**, wait until the side panel shows what it filled, scroll so the filled fields and the photos show. Do not click Publish; close the tab afterwards. Crop below Facebook's top bar and cover any Facebook-blue button left in the frame. |
| `4-todo.png` | The popup's **To do** tab after a rescan | Needs at least one of your own listings whose car sold or changed price on the website; rescan and open To do. If none exists yet, take this one later. |
| `5-numbers.png` | The **Numbers** tab | After a few posts, open Numbers in the popup. |

Then run:

```
npm run store-screenshots   # fits each capture onto 1280 x 800 as store/screenshots/1.png ... 5.png
npm run store-check         # checks their size and count with everything else
```

The fitter scales a capture down to fit (it never crops or shifts anything you covered) and centres it on white. Look at each result once more before uploading. Both folders are ignored by git: real screenshots stay on your computer and go only to the dashboard.

## Order and captions

Upload in the order 1 to 5. The dashboard takes no caption text; the captions in `store/listing.md` are for the website and for describing them to the reviewer if asked.
