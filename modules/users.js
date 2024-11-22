const bcrypt = require('bcrypt');
const mysql = require('mysql2');
const mysql1 = require('mysql2/promise'); // Use promise version
require('dotenv').config();
const { createTransaction } = require('./transaction');

// Database connection setup
const pool = mysql.createPool({
    host: process.env.DB_HOST, // Get host from .env file
    user: process.env.DB_USER, // Get user from .env file
    password: process.env.DB_PASSWORD, // Get password from .env file
    database: process.env.DB_NAME // Get database from .env file
});

const query = (sql, params) => {
    return new Promise((resolve, reject) => {
        pool.execute(sql, params, (err, results) => {
            if (err) {
                return reject(err);
            }
            resolve(results);
        });
    });
};
// Fetch user by username
const getUser = async (username) => {
    try {
        const [rows] = await query('SELECT * FROM users WHERE username = ?', [username]);
        console.log(rows);
        if (rows) {
            return rows;  // Return the user object directly
        }
        return null;
        } catch (err) {
        console.error('Error fetching user:', err);
        throw err;
    }
};

// Create a new user with a hashed password
const createUser = async (username, password, role = 'User') => {
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await query('INSERT INTO users (username, password, role, balance, version) VALUES (?, ?, ?, ?, ?)', 
            [username, hashedPassword, role, 0.0, 0]);
        console.log(`User ${username} created successfully.`);
    } catch (err) {
        console.error('Error creating user:', err);
        throw err;
    }
};

// Ensure admin user exists
const ensureAdminUser = async () => {
    try {
        const [rows] = await query('SELECT * FROM users WHERE username = ?', ['admin']);
        
        // Check if rows is defined and not empty
        if (!rows || rows.length === 0) {
            const hashedPassword = await bcrypt.hash('Spookytus', 10);
            await query('INSERT INTO users (username, password, role, balance, version) VALUES (?, ?, ?, ?, ?)', 
                ['admin', hashedPassword, 'Admin', 0.0, 0]);
            console.log('Default admin user created.');
        }
    } catch (err) {
        console.error('Error ensuring admin user:', err);
        throw err;
    }
};


const updateUserRole = async (targetuser, newRole, currentuser) => {
    const connection = await mysql1.createConnection({
        host: 'synczip.in',        // DB Host
        user: 'test',                  // DB User
        password: 'Test@123',          // DB Password
        database: 'AlphaBank'          // DB Name
    });

    try {
        // Start a transaction
        await connection.beginTransaction();

        // Fetch current user document (must be Admin)
        const [currentUserRows] = await connection.query('SELECT * FROM users WHERE username = ?', [currentuser]);
        if (currentUserRows.length === 0 || currentUserRows[0].role !== 'Admin') {
            return { success: false, message: 'You do not have permission to update user roles.' };
        }

        // Fetch target user document
        const [targetUserRows] = await connection.query('SELECT * FROM users WHERE username = ?', [targetuser]);
        if (targetUserRows.length === 0) {
            return { success: false, message: `User ${targetuser} not found.` };
        }

        const { version, role } = targetUserRows[0];

        // Validate role transitions
        const validTransitions = {
            User: ['Teller'],
            Teller: ['User', 'Admin'],
            Admin: ['Teller']
        };

        if (!validTransitions[role]?.includes(newRole)) {
            return { success: false, message: `Invalid role transition for ${targetuser}.` };
        }

        // Update the user role with version check for concurrency
        const [updateResult] = await connection.query(
            'UPDATE users SET role = ?, version = version + 1 WHERE username = ? AND role = ? AND version = ?',
            [newRole, targetuser, role, version]
        );

        if (updateResult.affectedRows === 1) {
            // Generate UUID for the transaction log
            const transactionId = uuidv4();  // This generates a unique UUIDv4

            // Log the transaction (insert into transactions table)
            // await connection.query(
            //     'INSERT INTO transactions (transactionid, fromUSername, toUsername, amount, type, status) VALUES (?, ?, ?, ?, ?, ?)',
            //     [transactionId, currentuser, targetuser, 0, 'role_update', 'approved'] // No monetary transaction, just role update
            // );

            // Commit the transaction
            await connection.commit();

            // Return success message with TXID
            return { success: true, message: `User ${targetuser} has been updated to ${newRole}. [Transaction ID: ${transactionId}]` };
        } else {
            return { success: false, message: `Concurrent modification detected for ${targetuser}. Update failed.` };
        }
    } catch (err) {
        // Rollback the transaction in case of any error
        await connection.rollback();
        console.error(`Error updating role for ${targetuser}:`, err);
        return { success: false, message: `An error occurred while updating the role for ${targetuser}.` };
    } finally {
        // Close the connection
        await connection.end();
    }
};


// const mysql = require('mysql2/promise'); // Assuming you're using mysql2
const { v4: uuidv4 } = require('uuid');  // Import the UUID generation function

const deposit = async (username, amount) => {
    const connection = await mysql1.createConnection({
        host: 'synczip.in',        // DB Host
        user: 'test',                  // DB User
        password: 'Test@123',          // DB Password
        database: 'AlphaBank'          // DB Name
    });
    try {
        // Start a transaction
        await connection.beginTransaction();

        // Fetch the user document and its version
        const [userRows] = await connection.query('SELECT * FROM users WHERE username = ?', [username]);
        
        // Check if user is found
        if (!userRows || userRows.length === 0) {
            return (`User ${username} not found.`);
        }

        // Extract the version and balance from the user record
        const { version, balance } = userRows[0];

        // Attempt to update the user's balance using optimistic locking
        const [updateResult] = await connection.query(
            'UPDATE users SET balance = balance + ?, version = version + 1 WHERE username = ? AND version = ?',
            [amount, username, version]
        );

        if (updateResult.affectedRows !== 1) {
            return (`Concurrent modification detected for ${username}. Deposit failed.`);
        }

        // Generate a UUID for the transaction ID
        const transactionId = uuidv4();  // This generates a unique UUIDv4

        // Log the transaction (inserting a new record into the transactions table)
        const [TXResult] = await connection.query(
            'INSERT INTO transactions (transactionid, fromUSername, toUsername, amount, type, status) VALUES (?, ?, ?, ?, ?, ?)',
            [transactionId, 'Bank', username, amount, 'deposit', 'approved']
        );

        // Commit the transaction
        await connection.commit();

        // Return success message with TXID
        return `Deposit successful! ${amount} has been added to ${username}'s account. [Transaction ID: ${transactionId}]`;

    } catch (err) {
        // Rollback the transaction in case of any error
        await connection.rollback();
        console.error('Error during deposit:', err);
        throw err;
    } finally {
        // Close the connection
        await connection.end();
    }
};


const withdraw = async (username, amount) => {
    const connection = await mysql1.createConnection({
        host: 'synczip.in',        // DB Host
        user: 'test',                  // DB User
        password: 'Test@123',          // DB Password
        database: 'AlphaBank'          // DB Name
    });

    try {
        // Start a transaction
        await connection.beginTransaction();

        // Fetch the user document and its version
        const [userRows] = await connection.query('SELECT * FROM users WHERE username = ?', [username]);
        if (userRows.length === 0) {
            return(`User ${username} not found.`);
        }

        const { balance, version } = userRows[0];

        // Check if the user has sufficient balance
        if (balance < amount) {
            return `Insufficient balance in ${username}'s account. Withdrawal failed.`;
        }

        // Attempt to deduct the amount using optimistic locking
        const [updateResult] = await connection.query(
            'UPDATE users SET balance = balance - ?, version = version + 1 WHERE username = ? AND version = ?',
            [amount, username, version]
        );

        if (updateResult.affectedRows === 1) {
            // Generate a UUID for the transaction ID
            const transactionId = uuidv4();  // This generates a unique UUIDv4

            // Log the transaction (inserting a new record into the transactions table)
            await connection.query(
                'INSERT INTO transactions (transactionid, fromUSername, toUsername, amount, type, status) VALUES (?, ?, ?, ?, ?, ?)',
                [transactionId, username, 'Bank', amount, 'withdrawal', 'approved']
            );

            // Commit the transaction
            await connection.commit();

            // Return success message with TXID
            return `Withdrawal successful! ${amount} has been deducted from ${username}'s account. [Transaction ID: ${transactionId}]`;

        } else {
            return(`Concurrent modification detected for ${username}. Withdrawal failed.`);
        }
    } catch (err) {
        // Rollback the transaction in case of any error
        await connection.rollback();
        console.error('Error during withdrawal:', err);
        throw err;
    } finally {
        // Close the connection
        await connection.end();
    }
};


// Get a user's balance
const getBalance = async (username) => {
    try {
        const [rows] = await query('SELECT balance FROM users WHERE username = ?', [username]);
        if (rows){
            return rows.balance;
        }
        return null;
    } catch (err) {
        console.error('Error fetching balance:', err);
        throw err;
    }
};

module.exports = { getUser, createUser, ensureAdminUser, updateUserRole, deposit, withdraw, getBalance };
