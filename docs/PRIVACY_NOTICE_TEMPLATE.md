# Privacy notice template for a coordination server

If people other than you use your Crocodile coordination server, tell them
who runs it and what it keeps. See
[If other people use your server](SELF_HOSTING.md#if-other-people-use-your-server).
Copy the notice below, fill in the parts in `[brackets]`, delete the rows for
features you haven't turned on, and publish it where your users will find it,
for example next to where you share the server's address. You may copy and
adapt it without restriction.

It describes what the Crocodile software stores. If you add anything (a
reverse proxy with its own logs, monitoring, backups), add that too. This is
not legal advice.

---

## Privacy notice for [server name]

_Last updated [date]_

[Server name] (`[server address]`) is a Crocodile coordination server run by
[your name, or your organisation's name and address], who is responsible for
the data described here. Contact: [email address].

Crocodile messages and calls are end-to-end encrypted, so this server can't
read them. They normally travel directly between the people talking; they pass
through this server only if you use its mailbox or relay (see below), and then
still encrypted. The server introduces people to each other and keeps the
records the Crocodile network needs.

### What the server keeps

| Data                                                                                                                                                               | Why                                                                   | How long                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Public profiles (name and number tag, avatar and bio if set), public keys and device names                                                                         | So people can find each other and encrypt to each other               | As long as the account exists                                                               |
| Spaces, their channels and members, and invites                                                                                                                    | So people's devices and their friends' devices stay in sync           | As long as the account exists, or until changed                                             |
| Each person's friends and blocked list, encrypted so that only their own devices can read it; the server sees whose list it is, its rough size and when it changes | So all of a person's devices have the same list                       | As long as the account exists, or until changed                                             |
| Friend requests and their answers, sealed so that only the recipient can read them and without the sender's name; the server sees recipient, time and size         | To deliver them, also to people who are offline                       | Until the recipient's app has read them, at most 30 days                                    |
| Who is online, which voice room they're in, when they connect                                                                                                      | To show presence and choose who hosts a call                          | Only while connected                                                                        |
| IP addresses, and connection setup data passed between people who call each other (which includes IP addresses)                                                    | To connect people, and to limit connections per address against abuse | In memory while connected; addresses that exceed the connection limit are logged for [days] |
| _Mailbox, if turned on:_ direct messages for people who are offline, sealed so only the recipient can open them; the server sees sender, recipient, time and size  | To deliver messages while the recipient is offline                    | Until delivered, at most [3] days                                                           |
| _Relay, if turned on:_ already-encrypted call and message traffic; the server sees its size and timing                                                             | For networks that block direct connections                            | Passed through live, nothing stored                                                         |

The first four rows are records of the whole Crocodile network, not only of
the people who use this server: each is kept by a few coordination servers
[(this server keeps a copy of all of them)], so that people on different
servers can reach each other. They are signed by
their owners, so servers can't forge them. Profiles, spaces and memberships
are not hidden from servers; friend lists and friend requests are encrypted.
While someone is connected, this server also sees whose presence their app
follows, whom they send a friend request or answer to, and whom they start
a direct message or call with; it doesn't keep
that after they disconnect.

### Legal basis

[For servers in the EU or serving people there; check that these fit how
you run your server:]

- For people who use this server, we process their data to provide the
  service they asked for (Article 6(1)(b) GDPR).
- We keep copies of the records of people on other servers for our
  legitimate interest, shared with them, in running a network where people
  on different servers can reach each other (Article 6(1)(f)).
- We keep logs and enforce connection limits for our legitimate interest in
  keeping the server secure and free of abuse (Article 6(1)(f)).

We don't sell data, use it for advertising, or share it with anyone except
the other servers of the Crocodile network as described above, or when the
law requires it.

### Your rights

You can ask us for a copy of the data we hold about you, or to correct or
delete it. Most of it you can see and change yourself in the app.

The records in the first four rows are signed by you and kept by several
servers in the network (a few chosen for each record, and any that keep a copy
of everything), so no single server can delete them for you: a copy deleted
here would come back from the others. To delete them everywhere, delete your
account in the app (Settings → Profile → Delete account). Every server that
holds them, this one included, then erases your devices, friends list, memberships, and
any friend requests and mail waiting for you. What remains is a marker with your account ID and
public key, named "Deleted user", and a "Deleted space" marker for each space
you owned, so the account and its spaces can't be brought back. For data only
this server has, such as its logs, ask us.

You also have the right to complain to your data protection
authority[, in [country]: [authority name and website]].
