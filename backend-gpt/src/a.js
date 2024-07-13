// host simple express server on 3000 to say hello world

// const express = require('express');
// const app = express();
// const port = 3000;

// app.get('/', (req, res) => {
//   const token = req.header("Authorization")
//   res.send('Hello World!' + token);
// });

// app.listen(port, () => {
//   console.log(`Example app listening at http://localhost:${port}`);
// });

const endOfSubs = new Date();
endOfSubs.setMonth(endOfSubs.getMonth() + 1);
console.log(endOfSubs);