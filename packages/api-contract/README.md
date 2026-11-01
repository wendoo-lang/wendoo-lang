# @wendoo/api-contract

The open contract of the Wendoo API service.

The API service holds accounts and sign-in and mints the connection tickets a
harness connection presents. This package defines what a client and any
implementation of that service agree on -- the account routes with their
request, response, and error schemas; the account site's sign-in and handoff
pages; and the handoff a client on another site signs in through -- plus a
client of those routes under `@wendoo/api-contract/client` and an in-memory
fake of the service under `@wendoo/api-contract/testing`.

## Install

```sh
npm install @wendoo/api-contract
```

## License

MIT
