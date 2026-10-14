# Shared wire fixtures

`records.json` is data, independent of Node and Duris. `chat[].wire` contains
complete UTF-8 wire records after JSON decoding, including the actual LF (or
CRLF) delimiter. `content` is the corresponding Discord text. `controls`
contains decoded objects; serialize each as JSON followed by LF. The auth token
is synthetic. `invalid` and `blank` exercise recovery and ignored input.

Feed chat records one byte at a time to exercise every possible UTF-8 split, or
concatenate them to exercise coalescing. For the record-byte boundary, the limit
is the UTF-8 byte length before LF, including a trailing CR when present. Accept
that exact size; discard one byte over and resume at the next LF.

These fixtures describe the shared [protocol](../../../docs/protocol.md).
They make no claim that a particular upstream MUD is tested or supported.
