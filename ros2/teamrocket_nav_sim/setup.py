from glob import glob
from setuptools import setup
setup(name='teamrocket_nav_sim', version='0.1.0', packages=['teamrocket_nav_sim'],
      data_files=[('share/ament_index/resource_index/packages', ['resource/teamrocket_nav_sim']),
                  ('share/teamrocket_nav_sim', ['package.xml']),
                  ('share/teamrocket_nav_sim/launch', glob('launch/*.py')),
                  ('share/teamrocket_nav_sim/config', glob('config/*.yaml'))],
      entry_points={'console_scripts': ['base = teamrocket_nav_sim.base:main', 'executor = teamrocket_nav_sim.executor:main', 'acceptance = teamrocket_nav_sim.acceptance:main']})
