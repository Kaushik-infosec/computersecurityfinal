const bcrypt = require('bcrypt');
const { getDb } = require('../config/db');

const USERS_COLLECTION = 'users';

// Fetch user by username
const getUser = async (username) => {
    const db = getDb();
    try {
        return await db.collection(USERS_COLLECTION).findOne({ username });
    } catch (err) {
        console.error('Error fetching user:', err);
        throw err;
    }
};

// Create a new user with a hashed password
const createUser = async (username, password, role = 'User') => {
    const db = getDb();
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.collection(USERS_COLLECTION).insertOne({
            username,
            password: hashedPassword,
            role,
            balance: 0.0
        });
        console.log(`User ${username} created successfully.`);
    } catch (err) {
        console.error('Error creating user:', err);
        throw err;
    }
};

// Ensure admin user exists
const ensureAdminUser = async () => {
    const db = getDb();
    try {
        const adminUser = await db.collection(USERS_COLLECTION).findOne({ username: 'admin' });
        if (!adminUser) {
            const hashedPassword = await bcrypt.hash('Spookytus', 10);
            await db.collection(USERS_COLLECTION).insertOne({
                username: 'admin',
                password: hashedPassword,
                role: 'Admin',
                balance: 0.0
            });
            console.log('Default admin user created.');
        }
    } catch (err) {
        console.error('Error ensuring admin user:', err);
        throw err;
    }
};

// Function to update a user's role (promote or demote)
const updateUserRole = async (username, newRole) => {
    const db = getDb();
    try {
        const result = await db.collection(USERS_COLLECTION).updateOne(
            { username },
            { $set: { role: newRole } }
        );
        if (result.modifiedCount === 1) {
            console.log(`User ${username} role updated to ${newRole}`);
            return result;
        } else {
            console.log(`No user found or no changes made for ${username}`);
            return null;
        }
    } catch (err) {
        console.error('Error updating user role:', err);
        throw err;
    }
};

// Deposit money into a user's account
const deposit = async (username, amount) => {
    const db = getDb();
    try {
        const result = await db.collection(USERS_COLLECTION).updateOne(
            { username },
            { $inc: { balance: amount } }
        );
        if (result.modifiedCount === 1) {
            return `Deposit successful! ${amount} has been added to ${username}'s account.`;
        } else {
            return `User ${username} not found or deposit failed.`;
        }
    } catch (err) {
        console.error('Error during deposit:', err);
        throw err;
    }
};

// Withdraw money from a user's account
const withdraw = async (username, amount) => {
    const db = getDb();
    try {
        const user = await getUser(username);
        if (!user) {
            return `User ${username} not found.`;
        }

        if (user.balance < amount) {
            return `Insufficient balance in ${username}'s account. Withdrawal failed.`;
        }

        const result = await db.collection(USERS_COLLECTION).updateOne(
            { username },
            { $inc: { balance: -amount } }
        );

        if (result.modifiedCount === 1) {
            return `Withdrawal successful! ${amount} has been deducted from ${username}'s account.`;
        } else {
            return `Withdrawal failed for ${username}.`;
        }
    } catch (err) {
        console.error('Error during withdrawal:', err);
        throw err;
    }
};

// Get a user's balance
const getBalance = async (username) => {
    const db = getDb();
    try {
        const user = await db.collection(USERS_COLLECTION).findOne({ username });
        return user ? user.balance : null;
    } catch (err) {
        console.error('Error fetching balance:', err);
        throw err;
    }
};

module.exports = { getUser, createUser, ensureAdminUser, updateUserRole, deposit, withdraw, getBalance };
