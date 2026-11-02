# ozerodb.github.io

A simple personal webpage

## Road to a Million

[`/millionaire/`](https://ozerodb.github.io/millionaire/) is a planner for getting to a million by investing a steady amount every month. It shows when you'd get there, how much you'd need each month to get there by a chosen age, the odds across 2,000 simulated markets, and which changes get you there sooner.

It's plain HTML, CSS and JavaScript with no build step and no dependencies. Everything runs in the browser and nothing you enter is sent anywhere.

The money math lives in `millionaire/calc.js`, separate from the page code, and has unit tests. Run them with Node.js 22 or newer:

```sh
cd millionaire
npm test
```
