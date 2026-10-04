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

Crocodile messages and calls are end-to-end encrypted and travel directly
between the people talking. This server never receives their content. It
introduces people to each other and keeps the records the Crocodile network
needs.

### What the server keeps

| Data                                                                                                                                                              | Why                                                                   | How long                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Public profiles (name and number tag, avatar and bio if set), public keys and device names                                                                        | So people can find each other and encrypt to each other               | As long as the account exists                                                               |
| Friends and blocked lists, spaces, their channels and members, and invites                                                                                        | So people's devices and their friends' devices stay in sync           | As long as the account exists, or until changed                                             |
| Who is online, which voice room they're in, when they connect                                                                                                     | To show presence and choose who hosts a call                          | Only while connected                                                                        |
| IP addresses, and connection setup data passed between people who call each other (which includes IP addresses)                                                   | To connect people, and to limit connections per address against abuse | In memory while connected; addresses that exceed the connection limit are logged for [days] |
| _Mailbox, if turned on:_ direct messages for people who are offline, sealed so only the recipient can open them; the server sees sender, recipient, time and size | To deliver messages while the recipient is offline                    | Until delivered, at most [3] days                                                           |
| _Relay, if turned on:_ already-encrypted call and message traffic; the server sees its size and timing                                                            | For networks that block direct connections                            | Passed through live, nothing stored                                                         |

The first two rows are records of the whole Crocodile network, not only of
the people who use this server: every coordination server keeps a copy, so
that people on different servers can reach each other. They are signed by
their owners, so servers can't forge them, but they are not hidden from
servers.

### Legal basis

[For servers in the EU or serving people there:] We process this data to
provide the service you asked for (Article 6(1)(b) GDPR), and keep logs and
enforce connection limits for our legitimate interest in keeping the server
secure and free of abuse (Article 6(1)(f)). We don't sell it, use it for
advertising, or share it with anyone except the other servers of the
Crocodile network as described above, or when the law requires it.

### Your rights

You can ask us for a copy of the data we hold about you, to correct it or to
delete it. Most of it you can see and change yourself in the app. Deleting
your account (Settings → Profile → Delete account) erases your records from
this server and from every other server in the network. You also have the
right to complain to your data protection authority[, in [country]:
[authority name and website]].
