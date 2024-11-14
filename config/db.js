
const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = 'AlphaBank';

let client;
let db;

const initializeDb = async () => {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DATABASE_NAME);
    console.log('Connected to the database');
};

const getDb = () => db;

module.exports = { initializeDb, getDb };
