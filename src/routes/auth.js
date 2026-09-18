const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username and password are required'
            });
        }

        const result = await pool.query(
            `
            SELECT
                u.user_id,
                u.employee_id,
                u.username,
                u.password_hash,
                u.status,
                u.branch_id,
                r.role_id,
                r.role_code,
                r.role_name
            FROM users u
            LEFT JOIN roles r
                ON r.role_id = u.role_id
            WHERE u.username = $1
            LIMIT 1
            `,
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid username or password'
            });
        }

        const user = result.rows[0];

        if (user.status !== 'ACTIVE') {
            return res.status(403).json({
                success: false,
                message: 'User account is not active'
            });
        }

        const passwordValid = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!passwordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid username or password'
            });
        }

        const permissionsResult = await pool.query(
            `
            SELECT p.permission_code
            FROM role_permissions rp
            JOIN permissions p
                ON p.permission_id = rp.permission_id
            WHERE rp.role_id = $1
            ORDER BY p.permission_code
            `,
            [user.role_id]
        );

        const permissions = permissionsResult.rows.map(
            row => row.permission_code
        );

        const token = jwt.sign(
            {
                user_id: user.user_id,
                employee_id: user.employee_id,
                username: user.username,
                role: user.role_code,
                branch_id: user.branch_id,
                permissions
            },
            process.env.JWT_SECRET,
            {
                expiresIn: '8h'
            }
        );

        await pool.query(
            `
            UPDATE users
            SET last_login_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
            `,
            [user.user_id]
        );

        return res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                user_id: user.user_id,
                    employee_id: user.employee_id,
                username: user.username,
                role: user.role_code,
                role_name: user.role_name,
                branch_id: user.branch_id,
                permissions
            }
        });

    } catch (error) {
        console.error('Login error:', error);

        return res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

router.get('/me', authenticateToken, (req, res) => {
    res.json({
        success: true,
        message: 'Current user information',
        user: req.user
    });
});

module.exports = router;
