**Last updated: 9 November 2026**

This policy says what Formamorph stores about you, why, for how long, and who else handles it. It covers the community server: accounts, published worlds, comments, likes, follows, and feedback. It also covers a daily send that counts active installs, and Formamorph AI, if you choose to use it. The game runs on your device. Unless you use Formamorph AI, nothing about a playthrough reaches us.

**Jake James** operates Formamorph. Write to **privacy@formamorph.ai** about anything in this policy.

## Who may have an account

You must be **at least 18 years old**, and of legal age to view adult content where you live. Some published content is adult. The app asks you to confirm this before it shows you community content.

## What we store

**Your account.** Your username, a hash of your password, your email address if you gave one, and your avatar image if you uploaded one. We never store the password itself.

**Your email address is optional.** If you add one, we use it to send you a verification link. Once verified, it can also receive password-reset links. We do not use it for marketing.

**What happens to the mail we send you.** For each account mail, we record whether it was delivered, delayed, bounced, or reported as spam. The record holds your account, the kind of mail, and when it was sent. It never holds your email address.

**What you publish.** Every world you upload, with its description, tags, thumbnail, content file, and update history. Your comments. The listings you like. The accounts you follow. Your contest entries and their placements.

**Your feedback.** Bug reports and suggestions, your replies in those threads, and your votes. A bug report also carries the diagnostics the app shows you before you send it: the app version, whether you run the browser or the desktop build, and a coarse summary such as `Windows · Chrome`. Reports you file about other people's content are stored with them.

**Your answers and your notices.** When you accept or decline a policy, we record which policy it was, which version you saw, when you answered, and which way you answered. When staff send you a notice inside the app, we record it and when you read or dismissed it.

**Timestamps.** Everything above records when it happened. Your account records when you created it, when it last changed, and when you last opened your notification feed.

**Moderation records.** When staff act on an account or a listing, the audit log records who acted, on whom, what they removed, and when. It keeps usernames.

**Your app version.** Every request carries which version of Formamorph you run and which build it is: browser, Windows, Linux, macOS, or Android. The server uses it to tell you when a feature needs a newer version than the one you have. It is written to the request log with the rest of the request line.

## The Signal

The server records a **Signal** when an account signs up, logs in, likes, publishes, comments, or follows. A Signal is a salted hash of your network address, plus a coarse browser family such as `Chrome/Windows`.

**We do not store the address.** We combine it with a secret salt and hash it. A Signal can therefore show that two accounts acted from the same place. Nobody can read the address back out of it.

Signals have one purpose: **to detect abuse**. One person may run several accounts to vote for their own contest entry, or to evade a suspension. Signals make that visible. Nothing else uses them.

**A Signal never causes anything to happen by itself.** There is no automatic block, hold, or score. A shared connection produces a shared Signal and no consequence. A household, a dorm, and a campus all look like this. A person decides what to do, using the same moderation tools as before.

**We delete Signals after 90 days.**

Our legal basis is **legitimate interest**. The community cannot stay usable if vote rings and ban evasion are undetectable in principle. Accepting this policy acknowledges that we told you. It is not consent, and declining does not switch collection off. If you object, delete your account. Your Signals go with it.

We also use your network address to **rate limit** requests, so no single source can flood the server. That use stores nothing.

## Liking while signed out

In the app you can like a listing without an account. We store the like against your **Install**: a random id that every copy of the app makes once, when it first needs it, and keeps in your browser's local storage. It names that copy of the app and nothing else. It carries nothing about you or your device, we never show it to you, and it never goes in a link.

Beside the like we store **a salted hash of your network address, and a coarse browser family** such as `Chrome/Windows`. We derive both the way we derive a Signal, and we do not store the address.

The hash has one purpose: **to limit and detect abuse**. It caps how many of these likes one connection may give one listing, and it lets staff see a number that was inflated from one place. Nothing else uses it.

**We blank the hash and the browser family after 90 days.** The like stays and still counts. Only where it came from goes.

**To take one of these likes back, press the heart again on the same copy of the app.**

**Signing in links your Install to your account**, whether or not it gave a like. Any likes it gave move to your account and become ordinary Likes. We record which account took the Install, so signing out again does not let the same copy of the app like a listing twice. Deleting your account deletes that record too.

## The kind of network behind a like

When you like a listing, signed in or not, we store **the kind of network the like came from**: a VPN, a hosting network, or Tor. A like from any other network stores nothing.

We find the kind by checking your network address against **lists kept on our own server**. Your address is never sent to anyone to check it. We do not store the address.

The kind has one purpose: **to detect abuse**. It lets staff see when a listing's likes were inflated from VPNs, cloud servers, or Tor. It never causes anything to happen by itself. A like from a VPN is accepted and counted like any other.

**We blank the kind after 90 days.** The like stays and still counts.

The VPN and hosting lists come from [X4BNet lists_vpn](https://github.com/X4BNet/lists_vpn), built from IP address data by [IPLocate.io](https://www.iplocate.io) under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The Tor list comes from the Tor Project.

## Counting the Formamorph AI offer

When the app shows you the Formamorph AI offer, it adds one to a **daily total** for each step you reach: the offer was shown, you opened the levels, you chose Patreon, or you finished the checklist. The total is a number per step per day.

**We store no address, no Install id, and no account with it.** Nothing in a total says who you are. We use the totals to learn whether the offer works.

## Counting active installs

Once a day, after you pass the age gate, the app tells our server that it was opened. We use it to count how many copies of the app people use, each day and each month.

**The send holds three things:** a hash of your Install, your platform, and your app version. It holds no play, no world, and no account. Our server sets the day by its own clock.

**The hash uses a key that changes every month.** The key is deleted when the month closes. Once the nightly copies that hold it are gone too, nobody can match a hash to your Install.

**While the month is open, the hash can be matched to your account** if you have signed in on that copy of the app. We store the Install beside the account when you sign in, and the hash comes from that Install.

**We delete the daily records when the month closes.** Nightly copies of the database can hold them for up to 30 days more. The **totals** stay with no end date. A total is a number per day or per month, split by platform and app version. Nothing in a total says who you are.

**You can turn the send off.** Open Settings, then Data, then Privacy, and turn off **Daily Check-In**. The app sends nothing after that.

## Using Formamorph AI

Formamorph AI is an optional AI service that we run. If you choose it in Settings, the app sends the text of each turn to our server, and our server passes it to **a third-party AI provider**. The text can include the world and your play so far.

**We do not keep that text.** Our server passes it on and stores no copy.

**The provider receives the text and an anonymous id.** The id stays the same across your turns, so the provider can tell that they came from one person. We do not send your username, your email address, or your network address.

**We record each call to measure use and cost:** your account, your Patreon user id or staff grant, your tier, the model, the type of prompt, the number of tokens, the token limit and the amount held for the call, the cost, the time, how long the call took, how it ended, and the version of the app that made the call. Staff can read these records. They hold no text from your play.

**We count each refused call.** When we refuse a call, we add one to a **daily total**. The total holds the reason for the refusal, your account, your Patreon user id or staff grant, your tier, and the first and last time that day. Staff can read these totals. They hold no text from your play.

**We delete these records and totals after 30 days.** If you delete your account, we remove your account from them at once. Your Patreon user id stays on them until the 30 days end.

## Linking Patreon

Linking a Patreon account is optional. If you link one, we store **your Patreon user id, your tier, the date your pledge started, when we last checked it, and whether your Supporter flair is on**. We do not store your name, your email address, or your payment details from Patreon.

We read our Patreon member list, and Patreon notifies us when a membership changes. We use these to keep your tier current.

**While your flair is on, other people can see your tier and the date your pledge started**, beside your username and avatar. You can turn the flair off at any time.

## Who else handles your data

**Hetzner** hosts the server in **Helsinki, Finland**. Your data lives there.

**Cloudflare** runs the domain's DNS, sits in front of the server as a proxy, and stores the published files. Cloudflare is the proxy, so **it handles every request you make**, including your network address.

**Amazon SES** (Amazon Web Services, in the United States) delivers verification and password-reset email. When we send one, Amazon SES receives your email address and the message. It tells us whether the mail was delivered, delayed, bounced, or reported as spam.

**Patreon** handles memberships and payments, under its own terms and privacy policy. If you link an account, Patreon tells us your Patreon user id and your membership details.

**A third-party AI provider** writes the replies for Formamorph AI. It receives what the section above describes, and only if you use Formamorph AI.

Except as described above, no one else receives your data. We do not sell it, and we do not use it for advertising.

## Any other AI service

Formamorph sends your play to the AI service you choose in Settings. **If you choose anything other than Formamorph AI, that text never reaches our server.** The app talks to that service directly from your device. It ships pointing at a third-party service, and you can change it to your own machine or to any other provider. What that service does with your text is between you and them.

Your worlds, saves, and settings stay in your own browser or on your own disk. They reach us only when you publish one.

## How long we keep things

- **Your account and what you published:** until you delete it.
- **Signals:** 90 days.
- **The address hash and browser family beside a like you gave while signed out:** 90 days. The like itself stays.
- **The kind of network beside a like:** 90 days. The like itself stays.
- **Delivery records of account mail:** 90 days.
- **Your Patreon link:** until you unlink it or delete your account.
- **Records and refusal totals of Formamorph AI calls:** 30 days. We keep no text from your play.
- **Daily records of active installs:** until the month closes.
- **Totals of active installs:** kept, with no end date.
- **Nightly copies of the database:** up to 30 days.
- **Published files:** mirrored to Cloudflare storage for as long as the listing exists.

Deleting something removes it from the live server at once. It can survive in a nightly copy for **up to 30 days**, and then it is gone from those too.

## Deleting your account

Open your profile and choose **Delete account**. You re-enter your password, so a stolen session cannot erase you.

You choose once **whether your published worlds and comments go too**. If you keep them, they stay under a fixed **[deleted user]** name with no profile behind it. Your name is gone even where your work stays. Contest placements keep the listing's name and drop yours.

A **seven-day Grace Period** follows. Nothing is hidden during it. **Logging back in cancels the deletion**, and the app tells you that it canceled. After seven days we erase the account and everything attached to it, Signals included. You do not have to come back to finish it.

**Moderation records keep your username afterwards.** If staff acted on your account, the audit row that names you survives the deletion. Erasure is not total, and this policy will not pretend otherwise.

**A suspended account cannot delete itself.** Ask through the in-app Feedback form instead. This stops the subject of a suspension from erasing its evidence.

## Your rights

You can read what the server holds about you from inside the app. Your profile, your listings, your comments, and your feedback threads are all yours. Write to **privacy@formamorph.ai** to ask for a copy, a correction, or anything else in this policy.

If this policy changes in a way that matters, we will ask you to read it again.
