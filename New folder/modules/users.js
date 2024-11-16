const bcrypt = require('bcrypt');
const { getDb } = require('../config/db');
const {createTransaction} = require('./transaction');
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
            balance: 0.0,
            version: 0
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
                balance: 0.0,
                version: 0
            });
            console.log('Default admin user created.');
        }
    } catch (err) {
        console.error('Error ensuring admin user:', err);
        throw err;
    }
};

// Function to update a user's role (promote or demote)
const updateUserRole = async (targetuser, newRole, currentuser) => {
    const db = getDb();
    
    // Fetch current user document
    const currentUserDoc = await db.collection(USERS_COLLECTION).findOne({ username: currentuser });
    
    if (!currentUserDoc || currentUserDoc.role !== 'Admin') {
      return { success: false, message: 'You do not have permission to update user roles.' };
    }
    
    // Fetch target user document
    const targetUserDoc = await db.collection(USERS_COLLECTION).findOne({ username: targetuser });
    
    if (!targetUserDoc) {
      return { success: false, message: `User ${targetuser} not found.` };
    }
    
    const { version, role } = targetUserDoc;
  
    // Validate role transitions
    const validTransitions = {
      User: ['Teller'],
      Teller: ['User', 'Admin'],
      Admin: ['Teller']
    };
  
    if (!validTransitions[role]?.includes(newRole)) {
      return { success: false, message: `Invalid role transition for ${targetuser}.` };
    }
  
    try {
      // Update the user role with version check for concurrency
      const updateResult = await db.collection(USERS_COLLECTION).findOneAndUpdate(
        { username: targetuser, role, version },
        { $set: { role: newRole }, $inc: { version: 1 } },
        { returnDocument: 'after' }
      );
  
      if (updateResult) {
        return { success: true, message: `User ${targetuser} has been updated to ${newRole}.` };
      } else {
        return { success: false, message: `Concurrent modification detected for ${targetuser}. Update failed.` };
      }
    } catch (err) {
      console.error(`Error updating role for ${targetuser}:`, err);
      return { success: false, message: `An error occurred while updating the role for ${targetuser}.` };
    }
  };
  

// Deposit money into a user's account
const deposit = async (username, amount) => {
    const db = getDb();

    // Fetch the user document and its version
    const user = await db.collection(USERS_COLLECTION).findOne({ username });

    if (!user) {
        throw new Error(`User ${username} not found.`);
    }

    const { version, balance } = user;

    try {
        // Attempt to update the user's balance using optimistic locking
        const updateResult = await db.collection(USERS_COLLECTION).updateOne(
            { username, version }, // Ensure the version matches
            {
                $inc: { balance: amount }, // Increment balance
                $set: { version: version + 1 } // Increment version
            }
        );

        if (updateResult.modifiedCount === 1) {
            // Log the transaction
            const TXID = await createTransaction('bank', username, amount, 'approved');
            return `Deposit successful! ${amount} has been added to ${username}'s account. [${TXID}]`;
        } else {
            throw new Error(`Concurrent modification detected for ${username}. Deposit failed.`);
        }
    } catch (err) {
        console.error('Error during deposit:', err);
        throw err;
    }
};


// Withdraw money from a user's account
const withdraw = async (username, amount) => {
    const db = getDb();

    // Fetch the user document and its version
    const user = await db.collection(USERS_COLLECTION).findOne({ username });

    if (!user) {
        throw new Error(`User ${username} not found.`);
    }

    const { balance, version } = user;

    // Check if the user has sufficient balance
    if (balance < amount) {
        return `Insufficient balance in ${username}'s account. Withdrawal failed.`;
    }

    try {
        // Attempt to deduct the amount using optimistic locking
        const updateResult = await db.collection(USERS_COLLECTION).updateOne(
            { username, version }, // Ensure the version matches
            {
                $inc: { balance: -amount }, // Deduct the amount
                $set: { version: version + 1 } // Increment the version
            }
        );

        if (updateResult.modifiedCount === 1) {
            // Log the transaction
            const TXID = await createTransaction(username, 'bank', amount, 'approved');
            return `Withdrawal successful! ${amount} has been deducted from ${username}'s account. [${TXID}]`;
        } else {
            throw new Error(`Concurrent modification detected for ${username}. Withdrawal failed.`);
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
