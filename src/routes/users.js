const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../db');
const {
    authenticateToken,
    requirePermission
} = require('../middleware/auth');

const router = express.Router();

/*
 * GET /api/users
 * عرض المستخدمين
 */
router.get(
    '/',
    authenticateToken,
    requirePermission('USERS_MANAGE'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    u.user_id,
                    u.username,
                    u.status,
                    u.employee_id,
                    e.employee_no,
                    e.full_name AS employee_name,
                    u.role_id,
                    r.role_code,
                    r.role_name,
                    u.branch_id,
                    b.branch_code,
                    b.branch_name,
                    u.last_login_at,
                    u.created_at,
                    u.updated_at
                FROM users u
                LEFT JOIN employees e
                    ON e.employee_id = u.employee_id
                LEFT JOIN roles r
                    ON r.role_id = u.role_id
                LEFT JOIN branches b
                    ON b.branch_id = u.branch_id
                ORDER BY u.user_id
            `);

            res.json({
                success: true,
                count: result.rows.length,
                users: result.rows
            });
        } catch (error) {
            console.error('Get users error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to get users'
            });
        }
    }
);


/*
 * GET /api/users/roles
 * عرض الأدوار مع صلاحياتها
 */
router.get(
    '/roles',
    authenticateToken,
    requirePermission('USERS_MANAGE'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    r.role_id,
                    r.role_code,
                    r.role_name,
                    r.description,
                    COALESCE(
                        json_agg(
                            json_build_object(
                                'permission_id', p.permission_id,
                                'permission_code', p.permission_code,
                                'permission_name', p.permission_name
                            )
                            ORDER BY p.permission_id
                        ) FILTER (WHERE p.permission_id IS NOT NULL),
                        '[]'::json
                    ) AS permissions
                FROM roles r
                LEFT JOIN role_permissions rp
                    ON rp.role_id = r.role_id
                LEFT JOIN permissions p
                    ON p.permission_id = rp.permission_id
                GROUP BY
                    r.role_id,
                    r.role_code,
                    r.role_name,
                    r.description
                ORDER BY r.role_id
            `);

            res.json({
                success: true,
                roles: result.rows
            });
        } catch (error) {
            console.error('Get roles error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to get roles'
            });
        }
    }
);


/*
 * GET /api/users/permissions
 * عرض جميع الصلاحيات المتاحة
 */
router.get(
    '/permissions',
    authenticateToken,
    requirePermission('USERS_MANAGE'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    permission_id,
                    permission_code,
                    permission_name,
                    description
                FROM permissions
                ORDER BY permission_id
            `);

            res.json({
                success: true,
                permissions: result.rows
            });
        } catch (error) {
            console.error('Get permissions error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to get permissions'
            });
        }
    }
);


/*
 * GET /api/users/:id
 * عرض مستخدم واحد
 */
router.get(
    '/:id',
    authenticateToken,
    requirePermission('USERS_MANAGE'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    u.user_id,
                    u.username,
                    u.status,
                    u.employee_id,
                    e.employee_no,
                    e.full_name AS employee_name,
                    u.role_id,
                    r.role_code,
                    r.role_name,
                    u.branch_id,
                    b.branch_code,
                    b.branch_name,
                    u.last_login_at,
                    u.created_at,
                    u.updated_at
                FROM users u
                LEFT JOIN employees e
                    ON e.employee_id = u.employee_id
                LEFT JOIN roles r
                    ON r.role_id = u.role_id
                LEFT JOIN branches b
                    ON b.branch_id = u.branch_id
                WHERE u.user_id = $1
            `, [req.params.id]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            res.json({
                success: true,
                user: result.rows[0]
            });
        } catch (error) {
            console.error('Get user error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to get user'
            });
        }
    }
);


/*
 * POST /api/users
 * إنشاء حساب مستخدم
 */
router.post(
    '/',
    authenticateToken,
    requirePermission('USERS_MANAGE'),
    async (req, res) => {
        try {
            const {
                employee_id,
                username,
                password,
                role_id,
                branch_id,
                status
            } = req.body;

            if (!username || !password) {
                return res.status(400).json({
                    success: false,
                    message: 'username and password are required'
                });
            }

            if (password.length < 6) {
                return res.status(400).json({
                    success: false,
                    message: 'Password must be at least 6 characters'
                });
            }

            const passwordHash = await bcrypt.hash(password, 12);

            const result = await pool.query(`
                INSERT INTO users
                (
                    employee_id,
                    username,
                    password_hash,
                    role_id,
                    branch_id,
                    status
                )
                VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    COALESCE($6, 'ACTIVE')
                )
                RETURNING
                    user_id,
                    employee_id,
                    username,
                    role_id,
                    branch_id,
                    status,
                    created_at,
                    updated_at
            `, [
                employee_id || null,
                username.trim(),
                passwordHash,
                role_id || null,
                branch_id || null,
                status || null
            ]);

            res.status(201).json({
                success: true,
                message: 'User created successfully',
                user: result.rows[0]
            });

        } catch (error) {
            console.error('Create user error:', error);

            if (error.code === '23505') {
                return res.status(409).json({
                    success: false,
                    message: 'Username or employee already has an account'
                });
            }

            res.status(500).json({
                success: false,
                message: 'Failed to create user'
            });
        }
    }
);


/*
 * PATCH /api/users/:id
 * تعديل بيانات المستخدم
 */
router.patch(
    '/:id',
    authenticateToken,
    requirePermission('USERS_MANAGE'),
    async (req, res) => {
        try {
            const {
                employee_id,
                username,
                role_id,
                branch_id,
                status
            } = req.body;

            if (!username) {
                return res.status(400).json({
                    success: false,
                    message: 'username is required'
                });
            }

            const result = await pool.query(`
                UPDATE users
                SET
                    employee_id = $1,
                    username = $2,
                    role_id = $3,
                    branch_id = $4,
                    status = COALESCE($5, status)
                WHERE user_id = $6
                RETURNING
                    user_id,
                    employee_id,
                    username,
                    role_id,
                    branch_id,
                    status,
                    last_login_at,
                    created_at,
                    updated_at
            `, [
                employee_id || null,
                username.trim(),
                role_id || null,
                branch_id || null,
                status || null,
                req.params.id
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            res.json({
                success: true,
                message: 'User updated successfully',
                user: result.rows[0]
            });

        } catch (error) {
            console.error('Update user error:', error);

            if (error.code === '23505') {
                return res.status(409).json({
                    success: false,
                    message: 'Username or employee already has an account'
                });
            }

            res.status(500).json({
                success: false,
                message: 'Failed to update user'
            });
        }
    }
);


/*
 * PATCH /api/users/:id/password
 * تغيير كلمة المرور
 */
router.patch(
    '/:id/password',
    authenticateToken,
    requirePermission('USERS_MANAGE'),
    async (req, res) => {
        try {
            const { password } = req.body;

            if (!password || password.length < 6) {
                return res.status(400).json({
                    success: false,
                    message: 'Password must be at least 6 characters'
                });
            }

            const passwordHash = await bcrypt.hash(password, 12);

            const result = await pool.query(`
                UPDATE users
                SET
                    password_hash = $1
                WHERE user_id = $2
                RETURNING user_id
            `, [
                passwordHash,
                req.params.id
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            res.json({
                success: true,
                message: 'Password updated successfully'
            });

        } catch (error) {
            console.error('Change password error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to change password'
            });
        }
    }
);


/*
 * PATCH /api/users/roles/:roleId/permissions
 * تعديل صلاحيات الدور
 */
router.patch(
    '/roles/:roleId/permissions',
    authenticateToken,
    requirePermission('USERS_MANAGE'),
    async (req, res) => {
        const client = await pool.connect();

        try {
            const { permission_ids } = req.body;
            const roleId = req.params.roleId;

            if (!Array.isArray(permission_ids)) {
                return res.status(400).json({
                    success: false,
                    message: 'permission_ids must be an array'
                });
            }

            await client.query('BEGIN');

            const roleResult = await client.query(
                `SELECT role_id FROM roles WHERE role_id = $1`,
                [roleId]
            );

            if (roleResult.rows.length === 0) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    success: false,
                    message: 'Role not found'
                });
            }

            /*
             * لا نسمح بحذف صلاحيات المدير النظامي بالكامل
             * حتى لا يتم قفل حساب الإدارة عن طريق الخطأ.
             */
            if (String(roleId) === '1' && permission_ids.length === 0) {
                await client.query('ROLLBACK');

                return res.status(400).json({
                    success: false,
                    message: 'System Administrator must keep permissions'
                });
            }

            await client.query(
                `DELETE FROM role_permissions WHERE role_id = $1`,
                [roleId]
            );

            if (permission_ids.length > 0) {
                await client.query(`
                    INSERT INTO role_permissions
                    (
                        role_id,
                        permission_id
                    )
                    SELECT
                        $1,
                        permission_id
                    FROM permissions
                    WHERE permission_id = ANY($2::bigint[])
                    ON CONFLICT DO NOTHING
                `, [
                    roleId,
                    permission_ids
                ]);
            }

            await client.query('COMMIT');

            res.json({
                success: true,
                message: 'Role permissions updated successfully'
            });

        } catch (error) {
            await client.query('ROLLBACK');

            console.error(
                'Update role permissions error:',
                error
            );

            res.status(500).json({
                success: false,
                message: 'Failed to update role permissions'
            });

        } finally {
            client.release();
        }
    }
);


module.exports = router;
